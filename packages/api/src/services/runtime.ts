import {
  bootstrapRuntimeRegistry,
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  checkRuntimeCapabilities,
  createRuntimeMemoryCache,
  createRuntimeModelDiscoveryService,
  createRuntimeWorkflowSpec,
  extractLatestRuntimeLimitSnapshot as extractLatestRuntimeLimitSnapshotRaw,
  extractRuntimeLimitSnapshotFromError as extractRuntimeLimitSnapshotFromErrorRaw,
  observeRuntimeLimitEvent as observeRuntimeLimitEventRaw,
  redactResolvedRuntimeProfile,
  resolveAdapterCapabilities,
  resolveRuntimeProfile,
  normalizeRuntimeLimitSnapshot,
  RUNTIME_TRUST_TOKEN,
  type RuntimeRunResult,
  type RuntimeCapabilityName,
  type RuntimeEvent,
  type RuntimeLimitSnapshot,
  type ResolvedRuntimeProfile,
  type RuntimeAdapter,
  type RuntimeModelDiscoveryService,
  type RuntimeRegistry,
  type RuntimeUsageContext,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import {
  clearRuntimeProfileLimitSnapshot,
  createDbUsageSink,
  type DbUsageEvent,
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  persistRuntimeProfileLimitSnapshot,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse,
  type ProjectRow,
} from "@aif/data";
import { broadcast } from "../ws.js";

const log = logger("api-runtime");

let runtimeRegistryPromise: Promise<RuntimeRegistry> | null = null;
let modelDiscoveryService: RuntimeModelDiscoveryService | null = null;
const runtimeLimitStateCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });
const runtimeLimitBroadcastCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });

/**
 * Wrappers that short-circuit the limit-observation pipeline when
 * `AIF_USAGE_LIMITS_ENABLED=false`. Callers (this file + chat route) import
 * these wrapped versions so a disabled deployment never parses stream events
 * for limit snapshots, never persists them, never broadcasts them.
 */
export function observeRuntimeLimitEvent(
  ...args: Parameters<typeof observeRuntimeLimitEventRaw>
): ReturnType<typeof observeRuntimeLimitEventRaw> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return args[1] ?? null;
  return observeRuntimeLimitEventRaw(...args);
}

export function extractLatestRuntimeLimitSnapshot(
  ...args: Parameters<typeof extractLatestRuntimeLimitSnapshotRaw>
): ReturnType<typeof extractLatestRuntimeLimitSnapshotRaw> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return extractLatestRuntimeLimitSnapshotRaw(...args);
}

export function extractRuntimeLimitSnapshotFromError(
  ...args: Parameters<typeof extractRuntimeLimitSnapshotFromErrorRaw>
): ReturnType<typeof extractRuntimeLimitSnapshotFromErrorRaw> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return extractRuntimeLimitSnapshotFromErrorRaw(...args);
}

export async function getApiRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (!runtimeRegistryPromise) {
    runtimeRegistryPromise = bootstrapRuntimeRegistry({
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `DEBUG [runtime-registry] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-module] ${message}`);
        },
        error(context, message) {
          log.error({ ...context }, `ERROR [runtime-registry] ${message}`);
        },
      },
      runtimeModules: getEnv().AIF_RUNTIME_MODULES ?? [],
      // DB-backed sink persists every successful run through the registry
      // wrapper. Structurally matches @aif/runtime's RuntimeUsageSink —
      // no cross-package type import needed.
      usageSink: createDbUsageSink({
        onRecorded: broadcastRuntimeUsageRefresh,
      }),
    }).catch((error) => {
      runtimeRegistryPromise = null;
      throw error;
    });
  }
  return runtimeRegistryPromise;
}

export async function getApiRuntimeModelDiscoveryService(): Promise<RuntimeModelDiscoveryService> {
  if (!modelDiscoveryService) {
    const registry = await getApiRuntimeRegistry();
    modelDiscoveryService = createRuntimeModelDiscoveryService({
      registry,
      cache: createRuntimeMemoryCache({ defaultTtlMs: 30_000 }),
      validationCache: createRuntimeMemoryCache({ defaultTtlMs: 15_000 }),
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `DEBUG [runtime-validation] ${message}`);
        },
        info(context, message) {
          log.info({ ...context }, `INFO [runtime-validation] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
        },
      },
    });
  }
  return modelDiscoveryService;
}

function broadcastRuntimeLimitUpdate(input: {
  projectId?: string | null;
  taskId?: string | null;
  runtimeProfileId: string;
  signature: string;
}): void {
  // Skip WS fan-out entirely when usage-limits feature is disabled —
  // the frontend UI that reacts to `project:runtime_limit_updated` is
  // gated on the same flag, so broadcasting is wasted work.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return;
  const projectId = input.projectId ?? null;
  if (!projectId) {
    log.debug(
      {
        runtimeProfileId: input.runtimeProfileId,
        taskId: input.taskId ?? null,
      },
      "Skipping runtime limit WS broadcast because no project is associated",
    );
    return;
  }

  const broadcastCacheKey = buildRuntimeLimitBroadcastCacheKey(input);
  if (!broadcastCacheKey) {
    return;
  }

  const cachedSignature = runtimeLimitBroadcastCache.get(broadcastCacheKey);
  if (cachedSignature === input.signature) {
    log.debug(
      {
        runtimeProfileId: input.runtimeProfileId,
        projectId,
        taskId: input.taskId ?? null,
      },
      "Skipped runtime limit WS broadcast because identical project/task state is still cached",
    );
    return;
  }

  broadcast({
    type: "project:runtime_limit_updated",
    payload: {
      projectId,
      runtimeProfileId: input.runtimeProfileId,
      taskId: input.taskId ?? null,
    },
  });
  runtimeLimitBroadcastCache.set(broadcastCacheKey, input.signature);
}

function broadcastRuntimeUsageRefresh(event: DbUsageEvent): void {
  const projectId = event.context.projectId ?? null;
  const runtimeProfileId = event.profileId ?? null;
  if (!projectId || !runtimeProfileId) {
    return;
  }

  broadcastRuntimeLimitUpdate({
    projectId,
    taskId: event.context.taskId ?? null,
    runtimeProfileId,
    signature: `usage:${event.recordedAt.toISOString()}:${event.context.source}:${event.usage.totalTokens}:${event.usage.inputTokens}:${event.usage.outputTokens}:${event.usage.costUsd ?? ""}`,
  });
}

export function refreshRuntimeProfileLimitState(input: {
  runtimeProfileId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  snapshot?: RuntimeLimitSnapshot | null;
  clearOnMissing?: boolean;
  taskId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  workflowKind?: string | null;
  reason: string;
}): void {
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const runtimeProfileId = input.runtimeProfileId ?? normalizedSnapshot?.profileId ?? null;
  if (!runtimeProfileId) {
    log.debug(
      {
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipping runtime limit state refresh because no runtime profile is associated",
    );
    return;
  }

  const signature = buildRuntimeLimitCacheSignature(
    normalizedSnapshot,
    input.clearOnMissing === true,
  );
  if (!signature) {
    log.debug(
      {
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "No runtime limit snapshot or clear action available for refresh",
    );
    return;
  }

  const cachedSignature = runtimeLimitStateCache.get(runtimeProfileId);
  const shouldPersist = cachedSignature !== signature;
  if (!shouldPersist) {
    log.debug(
      {
        runtimeProfileId,
        runtimeId: input.runtimeId ?? input.snapshot?.runtimeId ?? null,
        providerId: input.providerId ?? input.snapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipping runtime limit DB write because identical profile state is still cached; project-scoped broadcast will still be evaluated",
    );
  }

  try {
    if (shouldPersist) {
      const persistedAt = new Date().toISOString();
      log.debug(
        {
          runtimeProfileId,
          runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
          providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          conversationId: input.conversationId ?? null,
          workflowKind: input.workflowKind ?? null,
          reason: input.reason,
          cacheHit: false,
          action: normalizedSnapshot ? "persist" : "clear",
        },
        "Refreshing runtime profile limit state",
      );

      if (normalizedSnapshot) {
        persistRuntimeProfileLimitSnapshot(runtimeProfileId, normalizedSnapshot, persistedAt);
      } else {
        clearRuntimeProfileLimitSnapshot(runtimeProfileId, persistedAt);
      }
      runtimeLimitStateCache.set(runtimeProfileId, signature);
    }
    broadcastRuntimeLimitUpdate({
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      runtimeProfileId,
      signature,
    });
  } catch (error) {
    log.warn(
      {
        err: error,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Failed to refresh runtime profile limit state",
    );
  }
}

function parseRuntimeOptions(
  raw: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid runtime options JSON and continue with profile defaults
  }
  return undefined;
}

export interface RuntimeExecutionContext {
  project: ProjectRow;
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  selectionSource: "task_override" | "project_default" | "system_default" | "none" | "profile_id";
}

export async function resolveApiRuntimeContext(input: {
  projectId?: string | null;
  taskId?: string | null;
  mode: "task" | "chat";
  workflow: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  runtimeProfileId?: string | null;
  allowDisabled?: boolean;
}): Promise<RuntimeExecutionContext> {
  const task = input.taskId ? findTaskById(input.taskId) : undefined;
  const projectId = input.projectId ?? task?.projectId;
  if (!projectId) {
    throw new Error("Project ID is required to resolve runtime context");
  }

  const project = findProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(input.mode);
  const explicitProfileRow =
    input.runtimeProfileId != null ? findRuntimeProfileById(input.runtimeProfileId) : undefined;
  if (input.runtimeProfileId != null && !explicitProfileRow) {
    throw new Error(`Runtime profile ${input.runtimeProfileId} not found`);
  }
  if (explicitProfileRow?.projectId != null && explicitProfileRow.projectId !== projectId) {
    throw new Error(
      `Runtime profile ${explicitProfileRow.id} is not visible to project ${projectId}`,
    );
  }

  const explicitProfile = explicitProfileRow
    ? toRuntimeProfileResponse(explicitProfileRow)
    : undefined;
  const selection = explicitProfile
    ? {
        source: "profile_id" as const,
        profile: explicitProfile,
        taskRuntimeProfileId: task?.runtimeProfileId ?? null,
        projectRuntimeProfileId: null,
        systemRuntimeProfileId: systemDefaultRuntimeProfileId,
      }
    : resolveEffectiveRuntimeProfile({
        taskId: task?.id,
        projectId,
        mode: input.mode,
        systemDefaultRuntimeProfileId,
      });

  const profileRow =
    explicitProfileRow ??
    (selection.profile?.id ? findRuntimeProfileById(selection.profile.id) : undefined);
  const profile =
    explicitProfile ?? (profileRow ? toRuntimeProfileResponse(profileRow) : selection.profile);
  const runtimeOptionsFromTask = parseRuntimeOptions(task?.runtimeOptionsJson);
  const resolvedProfile = resolveRuntimeProfile({
    source: selection.source,
    profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
    workflow: input.workflow,
    modelOverride: input.modelOverride ?? task?.modelOverride ?? profile?.defaultModel ?? null,
    runtimeOptionsOverride: input.runtimeOptionsOverride ?? runtimeOptionsFromTask,
    allowDisabled: input.allowDisabled,
    env: process.env,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-resolution] ${message}`);
      },
      info(context, message) {
        log.info({ ...context }, `INFO [runtime-validation] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
      },
    },
  });

  const registry = await getApiRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolvedProfile.runtimeId);

  log.info(
    {
      projectId,
      taskId: task?.id ?? null,
      workflowKind: input.workflow.workflowKind,
      selectionSource: selection.source,
      ...redactResolvedRuntimeProfile(resolvedProfile),
    },
    "Resolved API runtime context",
  );

  return {
    project,
    adapter,
    resolvedProfile,
    selectionSource: selection.source,
  };
}

export function assertApiRuntimeCapabilities(input: {
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  workflow: RuntimeWorkflowSpec;
}): void {
  const capabilities = resolveAdapterCapabilities(input.adapter, input.resolvedProfile.transport);
  const result = checkRuntimeCapabilities({
    runtimeId: input.resolvedProfile.runtimeId,
    workflowKind: input.workflow.workflowKind,
    capabilities,
    required: input.workflow.requiredCapabilities,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-capabilities] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
      },
    },
  });

  if (!result.ok) {
    throw new Error(
      `Runtime "${input.resolvedProfile.runtimeId}" cannot execute "${input.workflow.workflowKind}": ${result.missing.join(", ")}`,
    );
  }
}

/**
 * Resolve the lightModel for the active runtime of a project/task.
 * Returns null if the adapter has no light model (use default).
 */
export async function resolveApiLightModel(
  projectId: string,
  taskId?: string | null,
): Promise<string | null> {
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
  const selection = resolveEffectiveRuntimeProfile({
    taskId: taskId ?? undefined,
    projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  });
  const resolved = resolveRuntimeProfile({
    source: selection.source,
    profile: selection.profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
  });
  const registry = await getApiRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolved.runtimeId);
  return adapter.descriptor.lightModel ?? null;
}

export async function runApiRuntimeOneShot(input: {
  projectId: string;
  projectRoot: string;
  taskId?: string | null;
  prompt: string;
  workflowKind?: string;
  requiredCapabilities?: RuntimeCapabilityName[];
  modelOverride?: string | null;
  systemPromptAppend?: string;
  includePartialMessages?: boolean;
  maxTurns?: number;
  /**
   * Hint for adapters that support slash-command / skill resolution (e.g.
   * Claude Code CLI). Passed through to the workflow spec so compatible
   * adapters can invoke the named skill instead of relying on the prompt
   * text alone. Adapters that do not support it ignore this field.
   */
  fallbackSlashCommand?: string;
  /**
   * Scope metadata for usage tracking. Callers must pick one `UsageSource`
   * value identifying the logical flow (fast-fix, commit, roadmap-*, ...).
   * `projectId` is always included automatically; `taskId` is added when the
   * caller passes one in `input.taskId`.
   */
  usageContext: RuntimeUsageContext;
}): Promise<{
  result: RuntimeRunResult;
  context: RuntimeExecutionContext;
}> {
  const env = getEnv();
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: input.workflowKind ?? "oneshot",
    prompt: input.prompt,
    requiredCapabilities: input.requiredCapabilities ?? [],
    sessionReusePolicy: "never",
    systemPromptAppend: input.systemPromptAppend,
    fallbackSlashCommand: input.fallbackSlashCommand,
  });

  const context = await resolveApiRuntimeContext({
    projectId: input.projectId,
    taskId: input.taskId,
    mode: "task",
    workflow,
    modelOverride: input.modelOverride,
  });

  assertApiRuntimeCapabilities({
    adapter: context.adapter,
    resolvedProfile: context.resolvedProfile,
    workflow,
  });

  const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  const onRuntimeEvent = (event: RuntimeEvent) => {
    latestLimitSnapshot = observeRuntimeLimitEvent(event, latestLimitSnapshot, {
      logger: log,
      observedMessage: "Observed runtime limit event during API execution",
      malformedMessage: "Dropped runtime limit event with malformed snapshot payload",
      logContext: {
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        workflowKind: workflow.workflowKind,
        runtimeId: context.resolvedProfile.runtimeId,
        runtimeProfileId: context.resolvedProfile.profileId,
      },
    });
  };
  let result: RuntimeRunResult;
  try {
    result = await context.adapter.run({
      runtimeId: context.resolvedProfile.runtimeId,
      providerId: context.resolvedProfile.providerId,
      profileId: context.resolvedProfile.profileId,
      transport: context.resolvedProfile.transport,
      workflowKind: workflow.workflowKind,
      prompt: input.prompt,
      model: context.resolvedProfile.model ?? undefined,
      projectRoot: input.projectRoot,
      cwd: input.projectRoot,
      headers: context.resolvedProfile.headers,
      // Merge caller's usageContext with scope fields we already know here.
      // The caller chooses the source (commit, fast-fix, ...); we fill in
      // projectId + taskId so the sink has the full scope automatically.
      usageContext: {
        ...input.usageContext,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
      },
      options: {
        ...context.resolvedProfile.options,
        ...(context.resolvedProfile.baseUrl ? { baseUrl: context.resolvedProfile.baseUrl } : {}),
        ...(context.resolvedProfile.apiKeyEnvVar
          ? { apiKeyEnvVar: context.resolvedProfile.apiKeyEnvVar }
          : {}),
      },
      execution: {
        // CLI/API transports produce output only after the full run completes,
        // so start timeout is meaningless — disable it and rely on run timeout only.
        startTimeoutMs:
          context.resolvedProfile.transport === "sdk" ? env.API_RUNTIME_START_TIMEOUT_MS : 0,
        runTimeoutMs: env.API_RUNTIME_RUN_TIMEOUT_MS,
        includePartialMessages: input.includePartialMessages ?? false,
        maxTurns: input.maxTurns,
        onEvent: onRuntimeEvent,
        systemPromptAppend: input.systemPromptAppend,
        bypassPermissions,
        environment: input.taskId
          ? { HANDOFF_MODE: "1", HANDOFF_TASK_ID: input.taskId }
          : { HANDOFF_MODE: "1" },
        hooks: {
          permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
          allowDangerouslySkipPermissions: bypassPermissions,
          _trustToken: RUNTIME_TRUST_TOKEN,
          settings: { attribution: { commit: "", pr: "" } },
          settingSources: ["project"],
        },
      },
    });

    latestLimitSnapshot = extractLatestRuntimeLimitSnapshot(result.events) ?? latestLimitSnapshot;
    if (latestLimitSnapshot) {
      refreshRuntimeProfileLimitState({
        runtimeProfileId: context.resolvedProfile.profileId,
        runtimeId: context.resolvedProfile.runtimeId,
        providerId: context.resolvedProfile.providerId,
        snapshot: latestLimitSnapshot,
        taskId: input.taskId ?? null,
        projectId: input.projectId,
        workflowKind: workflow.workflowKind,
        reason: "oneshot:success",
      });
    } else {
      log.debug(
        {
          runtimeProfileId: context.resolvedProfile.profileId,
          runtimeId: context.resolvedProfile.runtimeId,
          providerId: context.resolvedProfile.providerId,
          taskId: input.taskId ?? null,
          projectId: input.projectId,
          workflowKind: workflow.workflowKind,
        },
        "Preserving runtime limit state after successful API execution without an authoritative recovery signal",
      );
    }
  } catch (error) {
    refreshRuntimeProfileLimitState({
      runtimeProfileId: context.resolvedProfile.profileId,
      runtimeId: context.resolvedProfile.runtimeId,
      providerId: context.resolvedProfile.providerId,
      snapshot: extractRuntimeLimitSnapshotFromError(error),
      clearOnMissing: false,
      taskId: input.taskId ?? null,
      projectId: input.projectId,
      workflowKind: workflow.workflowKind,
      reason: "oneshot:error",
    });
    throw error;
  }

  log.info(
    {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workflowKind: workflow.workflowKind,
      runtimeId: context.resolvedProfile.runtimeId,
      profileId: context.resolvedProfile.profileId,
      providerId: context.resolvedProfile.providerId,
      model: context.resolvedProfile.model,
    },
    "INFO [api-runtime] One-shot runtime query completed",
  );

  return { result, context };
}
