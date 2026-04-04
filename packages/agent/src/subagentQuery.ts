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
  createClaudeRuntimeAdapter,
  createCodexRuntimeAdapter,
  createRuntimeRegistry,
  createRuntimeWorkflowSpec,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
  resolveRuntimePromptPolicy,
  type RuntimeCapabilityName,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeSessionReusePolicy,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import {
  createActivityLogger,
  createSubagentLogger,
  getClaudePath,
  logActivity,
  type RuntimeHookCallback,
} from "./hooks.js";
import { PROJECT_SCOPE_SYSTEM_APPEND } from "./constants.js";
import {
  createClaudeStderrCollector,
  explainClaudeFailure,
  probeClaudeCliFailure,
} from "./claudeDiagnostics.js";
import { writeQueryAudit } from "./queryAudit.js";
import { getActiveStageAbortController } from "./stageAbort.js";

const log = logger("subagent-query");

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RUNTIME_ID = "claude";
const DEFAULT_PROVIDER_ID = "anthropic";

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
  /** Additional SubagentStart hooks beyond the default activity/subagent loggers. */
  extraSubagentStartHooks?: RuntimeHookCallback[];
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

  runtimeRegistryPromise = (async () => {
    const env = getEnv();
    const registry = createRuntimeRegistry({
      logger: createRuntimeRegistryLogger(),
      builtInAdapters: [createClaudeRuntimeAdapter(), createCodexRuntimeAdapter()],
    });

    for (const moduleSpecifier of env.AIF_RUNTIME_MODULES) {
      try {
        await registry.registerRuntimeModule(moduleSpecifier);
      } catch (error) {
        log.warn(
          { moduleSpecifier, error },
          "Runtime module failed to load; continuing with built-in runtime adapters",
        );
      }
    }

    return registry;
  })();

  return runtimeRegistryPromise;
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
    mode: "task",
    systemDefaultRuntimeProfileId: null,
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
    fallbackRuntimeId: DEFAULT_RUNTIME_ID,
    fallbackProviderId: DEFAULT_PROVIDER_ID,
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

  const registry = await getRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolved.runtimeId);

  assertRuntimeCapabilities({
    runtimeId: resolved.runtimeId,
    workflowKind: workflow.workflowKind,
    capabilities: adapter.descriptor.capabilities,
    required: workflow.requiredCapabilities,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-capabilities] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
      },
    },
  });

  const promptPolicy = resolveRuntimePromptPolicy({
    runtimeId: resolved.runtimeId,
    capabilities: adapter.descriptor.capabilities,
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
    workflow.sessionReusePolicy === "resume_if_available" &&
    adapter.descriptor.capabilities.supportsResume;

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
    model: resolved.model,
    headers: resolved.headers,
    options: {
      ...resolved.options,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
      projectRoot: options.projectRoot,
    },
    prompt: promptPolicy.prompt,
    systemPromptAppend: promptPolicy.systemPromptAppend,
    agentDefinitionName: promptPolicy.agentDefinitionName,
    canResume,
  };
}

function buildAdapterMetadata(
  options: SubagentQueryOptions,
  workflow: RuntimeWorkflowSpec,
  systemPromptAppend: string,
  agentDefinitionName: string | undefined,
  stderr: (chunk: string) => void,
): Record<string, unknown> {
  const env = getEnv();
  const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
  const explicitAbort =
    options.abortController ?? getActiveStageAbortController(options.taskId) ?? undefined;

  const subagentStartHooks: RuntimeHookCallback[] = [createSubagentLogger(options.taskId)];
  for (const hook of options.extraSubagentStartHooks ?? []) {
    subagentStartHooks.push(hook);
  }

  return {
    maxBudgetUsd: options.maxBudgetUsd ?? null,
    agentDefinitionName,
    permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
    allowDangerouslySkipPermissions: bypassPermissions,
    pathToClaudeCodeExecutable: getClaudePath(),
    settings: { attribution: { commit: "", pr: "" } },
    settingSources: ["project"],
    systemPromptAppend,
    postToolUseHooks: [createActivityLogger(options.taskId)],
    subagentStartHooks,
    queryStartTimeoutMs: options.queryStartTimeoutMs ?? env.AGENT_QUERY_START_TIMEOUT_MS,
    queryStartRetryDelayMs: options.queryStartRetryDelayMs ?? env.AGENT_QUERY_START_RETRY_DELAY_MS,
    includePartialMessages: options.includePartialMessages ?? false,
    maxTurns: options.maxTurns,
    stderr,
    environment: {
      HANDOFF_MODE: "1",
      HANDOFF_TASK_ID: options.taskId,
      ...(options.skipReview ? { HANDOFF_SKIP_REVIEW: "1" } : {}),
    },
    workflowKind: workflow.workflowKind,
    abortController: explicitAbort,
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
  const stderrCollector = createClaudeStderrCollector();
  const heartbeatTimer = startHeartbeat(taskId);
  logActivity(taskId, "Agent", `${agentName} started`);

  let runtimeIdForError = DEFAULT_RUNTIME_ID;

  try {
    const context = await resolveExecutionContext(options);
    runtimeIdForError = context.runtimeId;
    const existingSessionId = context.canResume ? getTaskSessionId(taskId) : null;
    const shouldResume = Boolean(existingSessionId && context.canResume);

    const adapterMetadata = buildAdapterMetadata(
      options,
      context.workflow,
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
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: context.systemPromptAppend,
        },
        maxBudgetUsd: options.maxBudgetUsd ?? null,
        settingSources: ["project"],
      },
    });

    const registry = await getRuntimeRegistry();
    const adapter = registry.resolveRuntime(context.runtimeId);

    const runInput = {
      runtimeId: context.runtimeId,
      providerId: context.providerId,
      profileId: context.profileId,
      workflowKind: context.workflow.workflowKind,
      prompt: context.prompt,
      model: context.model ?? undefined,
      sessionId: existingSessionId,
      resume: shouldResume,
      projectRoot,
      cwd: projectRoot,
      headers: context.headers,
      options: context.options,
      metadata: adapterMetadata,
    } as const;

    const result =
      shouldResume && adapter.resume
        ? await adapter.resume({ ...runInput, sessionId: existingSessionId as string })
        : await adapter.run(runInput);

    const runtimeSessionId = result.sessionId ?? result.session?.id ?? null;
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
      `${agentName} complete (runtime=${context.runtimeId}, profile=${context.profileId ?? "default"}, model=${context.model ?? "default"})`,
    );

    return { resultText };
  } catch (error) {
    const reason =
      runtimeIdForError === "claude"
        ? await diagnoseFailure(error, stderrCollector, projectRoot)
        : error instanceof Error
          ? error.message
          : String(error);
    logActivity(taskId, "Agent", `${agentName} failed — ${reason}`);
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

/** Diagnose a subagent failure using stderr and CLI probe. */
export async function diagnoseFailure(
  err: unknown,
  stderrCollector: ReturnType<typeof createClaudeStderrCollector>,
  projectRoot: string,
): Promise<string> {
  let detail = stderrCollector.getTail();
  if (!detail) {
    detail = await probeClaudeCliFailure(projectRoot, getClaudePath());
  }
  return explainClaudeFailure(err, detail);
}
