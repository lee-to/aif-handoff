import {
  findTaskById,
  getTaskSessionId,
  incrementTaskTokenUsage,
  renewTaskClaim,
  resolveEffectiveRuntimeProfile,
  saveTaskSessionId,
  updateTaskHeartbeat,
} from "@aif/data";
import {
  assertRuntimeCapabilities,
  bootstrapRuntimeRegistry,
  createRuntimeWorkflowSpec,
  getResultSessionId,
  redactResolvedRuntimeProfile,
  resolveAdapterCapabilities,
  resolveRuntimeProfile,
  resolveRuntimePromptPolicy,
  RUNTIME_TRUST_TOKEN,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeCapabilityName,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeSessionReusePolicy,
  type RuntimeTransport,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import { logActivity } from "./hooks.js";
import { PROJECT_SCOPE_SYSTEM_APPEND } from "./constants.js";
import { createStderrCollector } from "./stderrCollector.js";
import { writeQueryAudit } from "./queryAudit.js";
import { getActiveStageAbortController } from "./stageAbort.js";

const log = logger("subagent-query");

const HEARTBEAT_INTERVAL_MS = 30_000;

const LOCK_RENEWAL_MS = Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;

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

function createRuntimeRegistryLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      log.debug({ ...context }, `DEBUG [runtime-registry] ${message}`);
    },
    warn(context, message) {
      log.warn({ ...context }, `WARN [runtime-module] ${message}`);
    },
  };
}

async function getRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (runtimeRegistryPromise) return runtimeRegistryPromise;

  runtimeRegistryPromise = bootstrapRuntimeRegistry({
    logger: createRuntimeRegistryLogger(),
    runtimeModules: getEnv().AIF_RUNTIME_MODULES,
  }).catch((error) => {
    runtimeRegistryPromise = null;
    throw error;
  });

  return runtimeRegistryPromise;
}

/**
 * Resolve the RuntimeAdapter that would handle a given task.
 * Useful for reading adapter metadata (e.g. lightModel) without running a query.
 */
export async function resolveAdapterForTask(
  taskId: string,
  mode: "task" | "plan" | "review" = "task",
): Promise<RuntimeAdapter> {
  const task = findTaskById(taskId);
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task?.projectId,
    mode,
    systemDefaultRuntimeProfileId: null,
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
  headers: Record<string, string>;
  options: Record<string, unknown>;
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  canResume: boolean;
}> {
  const task = findTaskById(options.taskId);
  const effective = resolveEffectiveRuntimeProfile({
    taskId: options.taskId,
    projectId: task?.projectId,
    mode: options.profileMode ?? "task",
    systemDefaultRuntimeProfileId: null,
  });
  const workflow = buildWorkflowSpec(options);
  const runtimeOptionsOverride = parseRuntimeOptions(task?.runtimeOptionsJson);
  const suppressModelFallback = options.suppressModelFallback === true;
  const modelOverride =
    options.modelOverride ?? (suppressModelFallback ? null : (task?.modelOverride ?? null));

  // Resolve adapter early to get lightModel for the resolution chain:
  // modelOverride → profile.defaultModel → lightModel → env default
  const registry = await getRuntimeRegistry();
  const effectiveRuntimeId = effective.profile?.runtimeId ?? getEnv().AIF_DEFAULT_RUNTIME_ID;
  const adapter = registry.resolveRuntime(effectiveRuntimeId);

  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    workflow,
    modelOverride,
    lightModelFallback: adapter.descriptor.lightModel ?? null,
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
    capabilities,
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

  const canResume =
    workflow.sessionReusePolicy === "resume_if_available" && capabilities.supportsResume;

  const profileLogContext = redactResolvedRuntimeProfile(resolved);
  log.info(
    {
      taskId: options.taskId,
      workflowKind: workflow.workflowKind,
      ...profileLogContext,
      usedFallbackSlashCommand: promptPolicy.usedFallbackSlashCommand,
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
    headers: resolved.headers,
    options: {
      ...resolved.options,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
      projectRoot: options.projectRoot,
    },
    prompt: promptPolicy.prompt,
    systemPromptAppend: promptPolicy.systemPromptAppend,
    agentDefinitionName: promptPolicy.agentDefinitionName,
    canResume,
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
    timeoutMs: options.queryStartTimeoutMs ?? env.AGENT_QUERY_START_TIMEOUT_MS,
    retryDelayMs: options.queryStartRetryDelayMs ?? env.AGENT_QUERY_START_RETRY_DELAY_MS,
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
  let adapter: RuntimeAdapter | null = null;

  try {
    const context = await resolveExecutionContext(options);
    runtimeIdForError = context.runtimeId;
    logActivity(
      taskId,
      "Agent",
      `${agentName} started (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"})`,
    );
    const existingSessionId = context.canResume ? getTaskSessionId(taskId) : null;
    const shouldResume = Boolean(existingSessionId && context.canResume);

    const executionIntent = buildExecutionIntent(
      options,
      context.systemPromptAppend,
      context.agentDefinitionName,
      stderrCollector.onStderr,
    );

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
      },
    });

    const registry = await getRuntimeRegistry();
    adapter = registry.resolveRuntime(context.runtimeId);

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
      metadata: {
        timeoutMs: getEnv().AGENT_STAGE_RUN_TIMEOUT_MS,
      },
    } as const;

    const result =
      shouldResume && adapter.resume
        ? await adapter.resume({ ...runInput, sessionId: existingSessionId as string })
        : await adapter.run(runInput);

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

    if (result.usage) {
      incrementTaskTokenUsage(taskId, {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
        total_cost_usd: result.usage.costUsd,
      });
    }

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
      `${agentName} complete (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"})`,
    );

    return { resultText };
  } catch (error) {
    let reason: string;
    if (adapter?.diagnoseError) {
      reason = await adapter.diagnoseError({
        error,
        stderrTail: stderrCollector.getTail(),
        projectRoot,
      });
    } else {
      reason = error instanceof Error ? error.message : String(error);
    }
    logActivity(taskId, "Agent", `${agentName} failed (runtime=${runtimeIdForError}) — ${reason}`);
    log.error(
      {
        taskId,
        err: error,
        runtimeId: runtimeIdForError,
        runtimeStderr: stderrCollector.getTail(),
      },
      `${agentName} execution failed`,
    );
    throw new Error(reason, { cause: error });
  } finally {
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
      renewTaskClaim(taskId, _coordinatorId, LOCK_RENEWAL_MS);
    }
  }, HEARTBEAT_INTERVAL_MS);
}
