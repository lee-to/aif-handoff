import {
  clearRuntimeProfileLimitSnapshot,
  createDbUsageSink,
  findTaskById,
  getAppDefaultRuntimeProfileId,
  getTaskSessionId,
  persistRuntimeProfileLimitSnapshot,
  renewTaskClaim,
  resolveEffectiveRuntimeProfile,
  saveTaskSessionId,
  updateTaskHeartbeat,
} from "@aif/data";
import {
  assertRuntimeCapabilities,
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  bootstrapRuntimeRegistry,
  createRuntimeMemoryCache,
  createRuntimeWorkflowSpec,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  observeRuntimeLimitEvent,
  sanitizeProviderMeta,
  getResultSessionId,
  redactResolvedRuntimeProfile,
  resolveAdapterCapabilities,
  resolveRuntimeProfile,
  resolveRuntimePromptPolicy,
  RuntimeExecutionError,
  RUNTIME_TRUST_TOKEN,
  UsageSource,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeCapabilityName,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeLimitSnapshot,
  type RuntimeSessionReusePolicy,
  type RuntimeTransport,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import { getEnv, logger, redactProviderTextForLogs } from "@aif/shared";
import { logActivity } from "./hooks.js";
import { PROJECT_SCOPE_SYSTEM_APPEND, REVIEW_DIFF_SCOPE_SYSTEM_APPEND } from "./constants.js";
import { createStderrCollector } from "./stderrCollector.js";
import { writeQueryAudit } from "./queryAudit.js";
import { getActiveStageAbortController } from "./stageAbort.js";
import { notifyProjectRuntimeLimitBroadcast } from "./notifier.js";

const log = logger("subagent-query");

const HEARTBEAT_INTERVAL_MS = 30_000;

const FIRST_ACTIVITY_TIMEOUT_ERROR = "first_activity_timeout";
const FIRST_ACTIVITY_MAX_RETRIES = 2;
const runtimeLimitStateCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });
const runtimeLimitBroadcastCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });

function notifyRuntimeUsageRefresh(input: {
  projectId?: string | null;
  runtimeProfileId?: string | null;
  taskId?: string | null;
}): void {
  if (!input.projectId || !input.runtimeProfileId) {
    return;
  }
  void notifyProjectRuntimeLimitBroadcast(input.projectId, input.runtimeProfileId, {
    taskId: input.taskId ?? null,
  });
}

function findRuntimeExecutionError(error: unknown): RuntimeExecutionError | null {
  if (error instanceof RuntimeExecutionError) {
    return error;
  }
  if (error instanceof Error && "cause" in error && error.cause) {
    return findRuntimeExecutionError(error.cause);
  }
  return null;
}

function buildSanitizedSubagentError(
  error: unknown,
  safeReason: ReturnType<typeof mapSafeRuntimeErrorReason>,
  providerId?: string | null,
): Error {
  const runtimeError = findRuntimeExecutionError(error);
  if (!runtimeError) {
    return new Error(safeReason.reason);
  }

  const normalizedSnapshot = runtimeError.limitSnapshot
    ? normalizeRuntimeLimitSnapshot(runtimeError.limitSnapshot)
    : null;

  return new RuntimeExecutionError(safeReason.reason, undefined, runtimeError.category, {
    adapterCode: runtimeError.adapterCode,
    httpStatus: runtimeError.httpStatus,
    resetAt: normalizedSnapshot?.resetAt ?? runtimeError.resetAt,
    retryAfterMs: runtimeError.retryAfterMs,
    retryAfterSeconds: runtimeError.retryAfterSeconds,
    limitSnapshot: normalizedSnapshot,
    providerMeta:
      normalizedSnapshot?.providerMeta ??
      sanitizeProviderMeta(
        normalizedSnapshot?.providerId ?? runtimeError.limitSnapshot?.providerId ?? providerId,
        runtimeError.providerMeta ?? null,
      ),
  });
}

function clearRuntimeLimitBroadcastCacheKeyIfUnchanged(
  broadcastCacheKey: string,
  signature: string,
): void {
  if (runtimeLimitBroadcastCache.get(broadcastCacheKey) === signature) {
    runtimeLimitBroadcastCache.delete(broadcastCacheKey);
  }
}

function refreshRuntimeProfileLimitState(input: {
  runtimeProfileId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  snapshot?: RuntimeLimitSnapshot | null;
  clearOnMissing?: boolean;
  taskId: string;
  workflowKind?: string | null;
  reason: string;
}): void {
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const runtimeProfileId = input.runtimeProfileId ?? normalizedSnapshot?.profileId ?? null;
  if (!runtimeProfileId) {
    log.debug(
      {
        taskId: input.taskId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
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
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
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
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipped runtime limit DB write because identical state is still cached",
    );
  }

  const persistedAt = new Date().toISOString();
  const taskRow = findTaskById(input.taskId);
  const projectId = taskRow?.projectId ?? null;
  const broadcastCacheKey = buildRuntimeLimitBroadcastCacheKey({
    projectId,
    taskId: input.taskId,
    runtimeProfileId,
  });
  const cachedBroadcastSignature = broadcastCacheKey
    ? runtimeLimitBroadcastCache.get(broadcastCacheKey)
    : null;
  const shouldBroadcast = Boolean(broadcastCacheKey) && cachedBroadcastSignature !== signature;

  try {
    if (shouldPersist) {
      log.debug(
        {
          taskId: input.taskId,
          runtimeProfileId,
          runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
          providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
          workflowKind: input.workflowKind ?? null,
          reason: input.reason,
          action: normalizedSnapshot ? "persist" : "clear",
        },
        "Refreshing runtime profile limit state for subagent execution",
      );

      if (normalizedSnapshot) {
        persistRuntimeProfileLimitSnapshot(runtimeProfileId, normalizedSnapshot, persistedAt);
      } else {
        clearRuntimeProfileLimitSnapshot(runtimeProfileId, persistedAt);
      }
      runtimeLimitStateCache.set(runtimeProfileId, signature);
    }

    if (shouldBroadcast && projectId && broadcastCacheKey) {
      runtimeLimitBroadcastCache.set(broadcastCacheKey, signature);
      void notifyProjectRuntimeLimitBroadcast(projectId, runtimeProfileId, {
        taskId: input.taskId,
      })
        .then((sent) => {
          if (!sent) {
            clearRuntimeLimitBroadcastCacheKeyIfUnchanged(broadcastCacheKey, signature);
            log.warn(
              {
                taskId: input.taskId,
                projectId,
                runtimeProfileId,
              },
              "Runtime limit broadcast was not delivered",
            );
          }
        })
        .catch((error) => {
          clearRuntimeLimitBroadcastCacheKeyIfUnchanged(broadcastCacheKey, signature);
          log.warn(
            {
              taskId: input.taskId,
              projectId,
              runtimeProfileId,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage:
                error instanceof Error
                  ? redactProviderTextForLogs(error.message)
                  : redactProviderTextForLogs(String(error)),
            },
            "Runtime limit broadcast failed",
          );
        });
    }
  } catch (error) {
    log.warn(
      {
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage:
          error instanceof Error
            ? redactProviderTextForLogs(error.message)
            : redactProviderTextForLogs(String(error)),
      },
      "Failed to refresh runtime profile limit state for subagent execution",
    );
  }
}

function getLockRenewalMs(): number {
  return Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;
}

/**
 * First-activity watchdog: aborts the agent if no runtime activity
 * arrives within AGENT_FIRST_ACTIVITY_TIMEOUT_MS after "started".
 * Detects hung agents early (~60s) instead of waiting for the 90-min stale timeout.
 */
function createFirstActivityWatchdog(
  timeoutMs: number,
  abortController: AbortController | undefined,
  onStall: () => void,
): { clear: () => void; markActivity: () => void; didFire: boolean } {
  if (timeoutMs <= 0) {
    return { clear: () => {}, markActivity: () => {}, didFire: false };
  }

  let fired = false;
  let cleared = false;

  const timer = setTimeout(() => {
    if (cleared) return;
    fired = true;
    onStall();
    if (abortController && !abortController.signal.aborted) {
      abortController.abort(new Error(FIRST_ACTIVITY_TIMEOUT_ERROR));
    }
  }, timeoutMs);

  return {
    get didFire() {
      return fired;
    },
    clear() {
      if (!fired && !cleared) {
        cleared = true;
        clearTimeout(timer);
      }
    },
    markActivity() {
      if (!fired && !cleared) {
        cleared = true;
        clearTimeout(timer);
      }
    },
  };
}

let runtimeRegistryPromise: Promise<RuntimeRegistry> | null = null;

export interface SubagentQueryOptions {
  taskId: string;
  projectRoot: string;
  agentName: string;
  prompt: string;
  maxBudgetUsd?: number | null;
  /** Preferred agent definition name. Runtime prompt policy may fallback to slash strategy. */
  agent?: string;
  /** Optional slash command fallback used when agent definitions are unavailable. */
  fallbackSlashCommand?: string;
  /** Runtime profile resolution mode — determines which project default is used. */
  profileMode?: "task" | "plan" | "review";
  /** Whether to skip code review stage (implementing → done instead of implementing → review). */
  skipReview?: boolean;
  /** Optional override for tests/tuning: timeout waiting for first message from query stream. */
  queryStartTimeoutMs?: number;
  /** Optional override for tests/tuning: delay before retrying after query_start_timeout. */
  queryStartRetryDelayMs?: number;
  /** AbortController for cancelling a running query from outside (e.g. stage timeout). */
  abortController?: AbortController;
  /** Optional explicit workflow spec. If omitted, a default one is generated from options. */
  workflowSpec?: RuntimeWorkflowSpec;
  /** Optional workflow kind used when auto-generating workflow spec. */
  workflowKind?: string;
  /** Required capabilities for this workflow. */
  requiredCapabilities?: RuntimeCapabilityName[];
  /** Session reuse policy for this workflow. */
  sessionReusePolicy?: RuntimeSessionReusePolicy;
  /** Runtime-level model override for this invocation. */
  modelOverride?: string | null;
  /** Disable task/profile model fallback and force adapter invocation without model. */
  suppressModelFallback?: boolean;
  /** Optional custom system append for the runtime workflow. */
  systemPromptAppend?: string;
  /** Optional partial-message stream mode (chat-like workflows). */
  includePartialMessages?: boolean;
  /** Optional max turns for runtime adapters that support it. */
  maxTurns?: number;
}

export interface SubagentQueryResult {
  resultText: string;
}

function parseRuntimeOptions(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Reasoning-effort key per runtime: claude/openrouter use `effort`,
// codex uses `modelReasoningEffort`, opencode uses `reasoningEffort`.
// Mirrors MANAGED_OPTION_KEYS in packages/web/src/components/settings/RuntimeProfileForm.tsx.
const EFFORT_OPTION_KEYS = ["effort", "modelReasoningEffort", "reasoningEffort"] as const;

function pickEffort(options: Record<string, unknown>): string | null {
  for (const key of EFFORT_OPTION_KEYS) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function createRuntimeRegistryLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      log.debug({ ...context }, `DEBUG [runtime-registry] ${message}`);
    },
    warn(context, message) {
      log.warn({ ...context }, `WARN [runtime-module] ${message}`);
    },
    error(context, message) {
      log.error({ ...context }, `ERROR [runtime-registry] ${message}`);
    },
  };
}

async function getRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (runtimeRegistryPromise) return runtimeRegistryPromise;

  runtimeRegistryPromise = bootstrapRuntimeRegistry({
    logger: createRuntimeRegistryLogger(),
    runtimeModules: getEnv().AIF_RUNTIME_MODULES,
    usageSink: createDbUsageSink({
      onRecorded: (event) => {
        notifyRuntimeUsageRefresh({
          projectId: event.context.projectId ?? null,
          runtimeProfileId: event.profileId ?? null,
          taskId: event.context.taskId ?? null,
        });
      },
    }),
  }).catch((error) => {
    runtimeRegistryPromise = null;
    throw error;
  });

  return runtimeRegistryPromise;
}

/**
 * Resolve the RuntimeAdapter that would handle a given task.
 * Useful for reading adapter metadata (e.g. lightModel) without running a query.
 * This helper is intentionally limited to task-stage modes; chat resolution
 * goes through the API runtime service instead.
 */
export async function resolveAdapterForTask(
  taskId: string,
  mode: "task" | "plan" | "review" = "task",
): Promise<RuntimeAdapter> {
  const task = findTaskById(taskId);
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(mode);
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task?.projectId,
    mode,
    systemDefaultRuntimeProfileId,
  });
  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
  });
  const registry = await getRuntimeRegistry();
  return registry.resolveRuntime(resolved.runtimeId);
}

function buildWorkflowSpec(options: SubagentQueryOptions): RuntimeWorkflowSpec {
  if (options.workflowSpec) return options.workflowSpec;

  return createRuntimeWorkflowSpec({
    workflowKind: options.workflowKind ?? options.agentName,
    prompt: options.prompt,
    requiredCapabilities: options.requiredCapabilities ?? [],
    agentDefinitionName: options.agent,
    fallbackSlashCommand: options.fallbackSlashCommand,
    sessionReusePolicy: options.sessionReusePolicy ?? "resume_if_available",
    systemPromptAppend: options.systemPromptAppend ?? PROJECT_SCOPE_SYSTEM_APPEND,
  });
}

async function resolveExecutionContext(options: SubagentQueryOptions): Promise<{
  workflow: RuntimeWorkflowSpec;
  runtimeId: string;
  providerId: string;
  profileId: string | null;
  transport: RuntimeTransport;
  capabilities: RuntimeCapabilities;
  model: string | null;
  effort: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  canResume: boolean;
  usedIsolatedSkillCommand: boolean;
  usedNativeSubagentWorkflow: boolean;
}> {
  const task = findTaskById(options.taskId);
  const profileMode = options.profileMode ?? "task";
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(profileMode);
  const effective = resolveEffectiveRuntimeProfile({
    taskId: options.taskId,
    projectId: task?.projectId,
    mode: profileMode,
    systemDefaultRuntimeProfileId,
  });
  const workflow = buildWorkflowSpec(options);
  const runtimeOptionsOverride = parseRuntimeOptions(task?.runtimeOptionsJson);
  const suppressModelFallback = options.suppressModelFallback === true;
  const modelOverride =
    options.modelOverride ?? (suppressModelFallback ? null : (task?.modelOverride ?? null));

  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    workflow,
    modelOverride,
    suppressModelFallback,
    runtimeOptionsOverride,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
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

  // Resolve adapter after profile — lightModel is NOT injected into the
  // general resolution chain. Callers that need lightModel (reviewGate)
  // pass it explicitly via modelOverride.
  const registry = await getRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolved.runtimeId);

  // Use transport-aware capabilities — adapters like Codex expose different
  // capabilities depending on the active transport (SDK vs CLI vs API).
  const capabilities = resolveAdapterCapabilities(adapter, resolved.transport);

  // Assert hard requirements, but exclude supportsAgentDefinitions —
  // promptPolicy handles fallback to slash commands when agent defs are unsupported.
  const hardRequired = workflow.requiredCapabilities.filter(
    (cap) => cap !== "supportsAgentDefinitions",
  );
  if (hardRequired.length > 0) {
    assertRuntimeCapabilities({
      runtimeId: resolved.runtimeId,
      workflowKind: workflow.workflowKind,
      capabilities,
      required: hardRequired,
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `DEBUG [runtime-capabilities] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
        },
      },
    });
  }

  const promptPolicy = resolveRuntimePromptPolicy({
    runtimeId: resolved.runtimeId,
    projectRoot: options.projectRoot,
    capabilities,
    runtimeOptions: resolved.options,
    workflow,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-workflow] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-workflow] ${message}`);
      },
    },
  });

  // Review-stage subagents (review-sidecar, security-sidecar) must only audit
  // the current task's diff, not the full codebase. Inject the scope rule here
  // so every review-mode query gets it regardless of the agent definition file.
  const effectiveSystemPromptAppend =
    (options.profileMode ?? "task") === "review"
      ? `${promptPolicy.systemPromptAppend}\n\n${REVIEW_DIFF_SCOPE_SYSTEM_APPEND}`.trim()
      : promptPolicy.systemPromptAppend;

  const baseCanResume =
    workflow.sessionReusePolicy === "resume_if_available" && capabilities.supportsResume;
  const requiresFreshSession =
    promptPolicy.usedIsolatedSkillCommand || promptPolicy.usedNativeSubagentWorkflow;
  const canResume = requiresFreshSession ? false : baseCanResume;
  if (baseCanResume && requiresFreshSession) {
    log.debug(
      {
        taskId: options.taskId,
        runtimeId: resolved.runtimeId,
        workflowKind: workflow.workflowKind,
      },
      "Workflow selected a fresh-session subagent strategy; forcing new session instead of resume",
    );
  }

  const profileLogContext = redactResolvedRuntimeProfile(resolved);
  log.info(
    {
      taskId: options.taskId,
      workflowKind: workflow.workflowKind,
      ...profileLogContext,
      usedFallbackSlashCommand: promptPolicy.usedFallbackSlashCommand,
      usedIsolatedSkillCommand: promptPolicy.usedIsolatedSkillCommand,
      usedNativeSubagentWorkflow: promptPolicy.usedNativeSubagentWorkflow,
      nativeSubagentFallbackReason: promptPolicy.nativeSubagentFallbackReason ?? null,
      suppressModelFallback,
      canResume,
    },
    "Resolved runtime execution context for subagent query",
  );

  if (!resolved.apiKey && resolved.transport !== "cli") {
    log.warn(
      {
        taskId: options.taskId,
        runtimeId: resolved.runtimeId,
        apiKeyEnvVar: resolved.apiKeyEnvVar,
      },
      "Runtime execution resolved without API key; adapter may fail depending on provider setup",
    );
  }

  return {
    workflow,
    runtimeId: resolved.runtimeId,
    providerId: resolved.providerId,
    profileId: resolved.profileId,
    transport: resolved.transport,
    capabilities,
    model: resolved.model,
    effort: pickEffort(resolved.options),
    headers: resolved.headers,
    options: {
      ...resolved.options,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
      projectRoot: options.projectRoot,
    },
    prompt: promptPolicy.prompt,
    systemPromptAppend: effectiveSystemPromptAppend,
    agentDefinitionName: promptPolicy.agentDefinitionName,
    canResume,
    usedIsolatedSkillCommand: promptPolicy.usedIsolatedSkillCommand,
    usedNativeSubagentWorkflow: promptPolicy.usedNativeSubagentWorkflow,
  };
}

function buildExecutionIntent(
  options: SubagentQueryOptions,
  systemPromptAppend: string,
  agentDefinitionName: string | undefined,
  stderr: (chunk: string) => void,
): import("@aif/runtime").RuntimeExecutionIntent {
  const env = getEnv();
  const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
  const explicitAbort =
    options.abortController ?? getActiveStageAbortController(options.taskId) ?? undefined;

  return {
    maxBudgetUsd: options.maxBudgetUsd ?? null,
    maxTurns: options.maxTurns,
    startTimeoutMs: options.queryStartTimeoutMs ?? env.AGENT_QUERY_START_TIMEOUT_MS,
    startRetryDelayMs: options.queryStartRetryDelayMs ?? env.AGENT_QUERY_START_RETRY_DELAY_MS,
    runTimeoutMs: env.AGENT_STAGE_RUN_TIMEOUT_MS,
    includePartialMessages: options.includePartialMessages ?? false,
    agentDefinitionName,
    systemPromptAppend,
    bypassPermissions,
    environment: {
      HANDOFF_MODE: "1",
      HANDOFF_TASK_ID: options.taskId,
      ...(options.skipReview ? { HANDOFF_SKIP_REVIEW: "1" } : {}),
    },
    abortController: explicitAbort,
    onStderr: stderr,
    onToolUse: (toolName, detail) => {
      logActivity(options.taskId, "Tool", `${toolName}${detail}`);
    },
    onSubagentStart: (name, id) => {
      const idSuffix = id ? ` (${id.slice(0, 8)})` : "";
      logActivity(options.taskId, "Subagent", `${name} started${idSuffix}`);
    },
    // Adapter-specific options — adapters read what they need, ignore the rest
    hooks: {
      _trustToken: RUNTIME_TRUST_TOKEN,
      settings: { attribution: { commit: "", pr: "" } },
      settingSources: ["project"],
    },
  };
}

/**
 * Execute a runtime-backed subagent query with standardized:
 * - heartbeat timer
 * - stderr collection
 * - audit logging
 * - activity logging
 * - token usage tracking
 * - error diagnosis
 */
export async function executeSubagentQuery(
  options: SubagentQueryOptions,
): Promise<SubagentQueryResult> {
  const { taskId, projectRoot, agentName } = options;
  const stderrCollector = createStderrCollector();
  const heartbeatTimer = startHeartbeat(taskId);

  let runtimeIdForError = getEnv().AIF_DEFAULT_RUNTIME_ID;
  let providerIdForError = getEnv().AIF_DEFAULT_PROVIDER_ID;
  let runtimeProfileIdForError: string | null = null;
  let workflowKindForError: string | null = null;
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  let adapter: RuntimeAdapter | null = null;
  let watchdog: ReturnType<typeof createFirstActivityWatchdog> | null = null;

  try {
    const context = await resolveExecutionContext(options);
    runtimeIdForError = context.runtimeId;
    providerIdForError = context.providerId;
    runtimeProfileIdForError = context.profileId;
    workflowKindForError = context.workflow.workflowKind;
    const effortSuffix = context.effort ? `, effort=${context.effort}` : "";
    logActivity(
      taskId,
      "Agent",
      `${agentName} started (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"}${effortSuffix})`,
    );
    const existingSessionId = context.canResume ? getTaskSessionId(taskId) : null;
    const shouldResume = Boolean(existingSessionId && context.canResume);

    writeQueryAudit({
      timestamp: new Date().toISOString(),
      taskId,
      agentName,
      projectRoot,
      prompt: context.prompt,
      options: {
        runtimeId: context.runtimeId,
        providerId: context.providerId,
        profileId: context.profileId,
        workflowKind: context.workflow.workflowKind,
        model: context.model,
        systemPromptAppend: context.systemPromptAppend,
        maxBudgetUsd: options.maxBudgetUsd ?? null,
        usedIsolatedSkillCommand: context.usedIsolatedSkillCommand,
        usedNativeSubagentWorkflow: context.usedNativeSubagentWorkflow,
      },
    });

    const registry = await getRuntimeRegistry();
    adapter = registry.resolveRuntime(context.runtimeId);

    // First-activity watchdog requires a transport that surfaces incremental
    // runtime activity in real time. SDK / CLI adapters emit RuntimeEvent
    // callbacks for streamed text, reasoning, and tool summaries, so any such
    // event proves the runtime is alive even if the workflow performs no tool
    // calls. API transport is pure HTTP — no intermediate events — and must
    // stay disabled.
    //
    // CLI gets a 2x buffer over SDK because it carries extra cold-start cost
    // the SDK path doesn't have: binary spawn (~1-3s) and the initial
    // system/init exchange with the full tool/MCP catalogue. Without the
    // buffer, slow first-turn startup on CLI can false-positive the watchdog.
    const baseFirstActivityTimeoutMs = getEnv().AGENT_FIRST_ACTIVITY_TIMEOUT_MS;
    const firstActivityTimeoutMs =
      context.transport === "api"
        ? 0
        : context.transport === "cli"
          ? baseFirstActivityTimeoutMs * 2
          : baseFirstActivityTimeoutMs;
    let result: Awaited<ReturnType<RuntimeAdapter["run"]>> | undefined;

    // Retry loop: if agent stalls (no runtime activity after start), kill and restart
    for (let attempt = 0; attempt <= FIRST_ACTIVITY_MAX_RETRIES; attempt++) {
      latestLimitSnapshot = null;
      // Fresh AbortController per attempt — AbortController is single-use
      const attemptAbort = new AbortController();
      // Chain to the external abort if provided (stage timeout, shutdown)
      const externalAbort =
        options.abortController ?? getActiveStageAbortController(taskId) ?? undefined;
      if (externalAbort?.signal.aborted) {
        attemptAbort.abort(externalAbort.signal.reason);
      } else {
        externalAbort?.signal.addEventListener(
          "abort",
          () => attemptAbort.abort(externalAbort.signal.reason),
          { once: true },
        );
      }

      const executionIntent = buildExecutionIntent(
        options,
        context.systemPromptAppend,
        context.agentDefinitionName,
        stderrCollector.onStderr,
      );
      // Override the abort controller with our per-attempt one
      executionIntent.abortController = attemptAbort;
      // API transport is pure HTTP — no incremental stream — so the
      // start-timeout watchdog has nothing to observe and must stay off.
      // SDK streams in-process and CLI now streams JSONL events (system/init
      // arrives in the first few hundred ms), so both tolerate start timeout.
      if (context.transport === "api") {
        executionIntent.startTimeoutMs = 0;
      }

      // Set up first-activity watchdog for this attempt
      watchdog = createFirstActivityWatchdog(firstActivityTimeoutMs, attemptAbort, () => {
        const timeoutSec = Math.round(firstActivityTimeoutMs / 1000);
        logActivity(
          taskId,
          "Agent",
          `${agentName} stalled — no runtime activity within ${timeoutSec}s after start (attempt ${attempt + 1}/${FIRST_ACTIVITY_MAX_RETRIES + 1}), restarting`,
        );
        log.warn(
          { taskId, agentName, firstActivityTimeoutMs, attempt: attempt + 1 },
          "First-activity watchdog triggered: killing and restarting agent",
        );
      });

      // Install an onEvent bridge even when the caller did not request
      // streamed events directly: the watchdog needs a callback to observe
      // runtime activity for tool-less workflows such as checklist sync.
      const wd = watchdog!;
      const originalOnEvent = executionIntent.onEvent ?? (() => undefined);
      const originalOnToolUse = executionIntent.onToolUse;
      const originalOnSubagentStart = executionIntent.onSubagentStart;
      executionIntent.onEvent = (event) => {
        wd.markActivity();
        latestLimitSnapshot = observeRuntimeLimitEvent(event, latestLimitSnapshot, {
          logger: log,
          observedMessage: "Observed runtime limit event during subagent execution",
          malformedMessage: "Dropped runtime limit event with malformed snapshot payload",
          logContext: {
            taskId,
            runtimeId: context.runtimeId,
            runtimeProfileId: context.profileId,
            workflowKind: context.workflow.workflowKind,
            attempt: attempt + 1,
          },
        });
        originalOnEvent(event);
      };
      if (originalOnToolUse) {
        executionIntent.onToolUse = (toolName, detail) => {
          wd.markActivity();
          originalOnToolUse(toolName, detail);
        };
      }
      if (originalOnSubagentStart) {
        executionIntent.onSubagentStart = (name, id) => {
          wd.markActivity();
          originalOnSubagentStart(name, id);
        };
      }

      // Look up project scope fresh per attempt so a retry that sees a
      // re-parented task still records against the correct project.
      const projectIdForUsage = findTaskById(taskId)?.projectId ?? null;

      const runInput = {
        runtimeId: context.runtimeId,
        providerId: context.providerId,
        profileId: context.profileId,
        workflowKind: context.workflow.workflowKind,
        transport: context.transport,
        prompt: context.prompt,
        model: context.model ?? undefined,
        sessionId: existingSessionId,
        resume: shouldResume,
        projectRoot,
        cwd: projectRoot,
        headers: context.headers,
        options: context.options,
        execution: executionIntent,
        usageContext: {
          source: UsageSource.SUBAGENT,
          projectId: projectIdForUsage,
          taskId,
        },
      } as const;

      try {
        result =
          shouldResume && adapter.resume
            ? await adapter.resume({ ...runInput, sessionId: existingSessionId as string })
            : await adapter.run(runInput);
        // Success — break out of retry loop
        watchdog.clear();
        break;
      } catch (err) {
        const stalledByWatchdog = watchdog.didFire;
        watchdog.clear();
        if (stalledByWatchdog && attempt < FIRST_ACTIVITY_MAX_RETRIES) {
          // Agent stalled — kill and retry
          log.info(
            { taskId, agentName, attempt: attempt + 1, maxRetries: FIRST_ACTIVITY_MAX_RETRIES },
            "Restarting agent after first-activity stall",
          );
          continue;
        }
        // Not a stall or retries exhausted — re-throw
        throw err;
      }
    }

    if (!result) {
      throw new Error(
        `${agentName}: all ${FIRST_ACTIVITY_MAX_RETRIES + 1} attempts stalled without runtime activity`,
      );
    }

    latestLimitSnapshot = extractLatestRuntimeLimitSnapshot(result.events) ?? latestLimitSnapshot;
    if (latestLimitSnapshot) {
      refreshRuntimeProfileLimitState({
        runtimeProfileId: context.profileId,
        runtimeId: context.runtimeId,
        providerId: context.providerId,
        snapshot: latestLimitSnapshot,
        taskId,
        workflowKind: context.workflow.workflowKind,
        reason: "subagent:success",
      });
    } else {
      log.debug(
        {
          taskId,
          runtimeProfileId: context.profileId,
          runtimeId: context.runtimeId,
          providerId: context.providerId,
          workflowKind: context.workflow.workflowKind,
        },
        "Preserving runtime limit state after successful subagent execution without an authoritative recovery signal",
      );
    }

    const runtimeSessionId = getResultSessionId(result, context.capabilities);
    if (runtimeSessionId && context.canResume) {
      saveTaskSessionId(taskId, runtimeSessionId);
      log.debug({ taskId, agentName, runtimeSessionId }, "Captured runtime session ID");
    } else if (runtimeSessionId) {
      log.debug(
        {
          taskId,
          agentName,
          runtimeSessionId,
          sessionReusePolicy: context.workflow.sessionReusePolicy,
        },
        "Skipped runtime session persistence for non-resumable workflow",
      );
    }

    // Usage is recorded automatically by the registry wrapper via the DB
    // usage sink (see packages/data createDbUsageSink + packages/runtime
    // registry.wrapAdapter). No manual increment needed here.

    const resultText = result.outputText ?? "";

    log.info(
      {
        taskId,
        agentName,
        runtimeId: context.runtimeId,
        profileId: context.profileId,
        model: context.model,
        resumed: shouldResume,
      },
      "Subagent query completed successfully",
    );
    logActivity(
      taskId,
      "Agent",
      `${agentName} complete (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"}${effortSuffix})`,
    );

    return { resultText };
  } catch (error) {
    refreshRuntimeProfileLimitState({
      runtimeProfileId: runtimeProfileIdForError,
      runtimeId: runtimeIdForError,
      providerId: providerIdForError,
      snapshot: extractRuntimeLimitSnapshotFromError(error),
      clearOnMissing: false,
      taskId,
      workflowKind: workflowKindForError,
      reason: "subagent:error",
    });
    const safeReason = mapSafeRuntimeErrorReason(error);
    let diagnosticsReason: string | null = null;
    if (adapter?.diagnoseError) {
      diagnosticsReason = await adapter.diagnoseError({
        error,
        stderrTail: stderrCollector.getTail(),
        projectRoot,
      });
    } else {
      diagnosticsReason = error instanceof Error ? error.message : String(error);
    }
    if (
      diagnosticsReason &&
      diagnosticsReason.trim().length > 0 &&
      diagnosticsReason.trim() !== safeReason.reason
    ) {
      log.debug(
        {
          taskId,
          runtimeId: runtimeIdForError,
          category: safeReason.category,
          diagnosticsReason: redactProviderTextForLogs(diagnosticsReason),
        },
        "Redacted runtime diagnostics before writing task activity",
      );
    }
    logActivity(
      taskId,
      "Agent",
      `${agentName} failed (runtime=${runtimeIdForError}) — ${safeReason.reason}`,
    );
    log.error(
      {
        taskId,
        runtimeId: runtimeIdForError,
        category: safeReason.category,
        errorName: error instanceof Error ? error.name : typeof error,
        diagnosticsReason:
          diagnosticsReason && diagnosticsReason.trim().length > 0
            ? redactProviderTextForLogs(diagnosticsReason)
            : null,
        runtimeStderr: redactProviderTextForLogs(stderrCollector.getTail()),
      },
      `${agentName} execution failed`,
    );
    throw buildSanitizedSubagentError(error, safeReason, providerIdForError);
  } finally {
    try {
      watchdog?.clear();
    } catch {
      // safety guard
    }
    try {
      clearInterval(heartbeatTimer);
    } catch {
      // safety guard
    }
  }
}

// Coordinator ID injected at startup to avoid circular imports
let _coordinatorId: string | null = null;
export function setCoordinatorId(id: string): void {
  _coordinatorId = id;
}

/** Start a periodic heartbeat that updates the task's lastHeartbeatAt and renews the lock. */
export function startHeartbeat(taskId: string): NodeJS.Timeout {
  return setInterval(() => {
    updateTaskHeartbeat(taskId);
    if (_coordinatorId) {
      renewTaskClaim(taskId, _coordinatorId, getLockRenewalMs());
    }
  }, HEARTBEAT_INTERVAL_MS);
}
