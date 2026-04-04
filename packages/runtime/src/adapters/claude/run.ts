import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
import { classifyClaudeResultSubtype, classifyClaudeRuntimeError } from "./errors.js";
import { buildClaudeHooks } from "./hooks.js";

const QUERY_START_TIMEOUT_CODE = "query_start_timeout";

export interface ClaudeRuntimeRunLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface ClaudeRuntimeExecutionOptions {
  maxBudgetUsd?: number | null;
  agentDefinitionName?: string;
  permissionMode?: "acceptEdits" | "bypassPermissions" | string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
  settingSources?: string[];
  settings?: { attribution?: { commit?: string; pr?: string } };
  systemPromptAppend?: string;
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
  includePartialMessages?: boolean;
  maxTurns?: number;
  queryStartTimeoutMs?: number;
  queryStartRetryDelayMs?: number;
  environment?: Record<string, string>;
  stderr?: (chunk: string) => void;
  onEvent?: (event: RuntimeEvent) => void;
  abortController?: AbortController;
}

interface QueryStartTimeoutError extends Error {
  code: typeof QUERY_START_TIMEOUT_CODE;
}

interface ClaudeRuntimeRunInternalInput {
  input: RuntimeRunInput;
  execution: ClaudeRuntimeExecutionOptions;
  logger: ClaudeRuntimeRunLogger;
}

interface ClaudeRuntimeRunAttemptResult {
  outputText: string;
  sessionId: string | null;
  events: RuntimeEvent[];
  usage: RuntimeUsage | null;
}

interface RuntimeGlobalWithQueryMock {
  __AIF_CLAUDE_QUERY_MOCK__?: typeof query;
}

interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
  summary?: string;
  [key: string]: unknown;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toStringRecord(value: Record<string, unknown> | null): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeQueryStartTimeoutError(timeoutMs: number): QueryStartTimeoutError {
  const error = new Error(
    `query_start_timeout: claude runtime produced no output within ${timeoutMs}ms`,
  ) as QueryStartTimeoutError;
  error.code = QUERY_START_TIMEOUT_CODE;
  return error;
}

function isQueryStartTimeoutError(error: unknown): error is QueryStartTimeoutError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === QUERY_START_TIMEOUT_CODE,
  );
}

function normalizeUsage(message: ClaudeStreamMessage): RuntimeUsage | null {
  const usage = message.usage ?? {};
  const inputTokens = toNumber(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
  );
  const outputTokens = toNumber(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
  );
  const totalTokens = toNumber(
    usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens,
  );
  const costUsd = toNumber(message.total_cost_usd);

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && costUsd === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}

function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("no conversation found with session id") ||
    lowered.includes("no conversation found for session id") ||
    lowered.includes("session not found")
  );
}

function isRetryableResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    isMissingResumeSessionError(error) ||
    lowered.includes("error_during_execution") ||
    lowered.includes("claude code returned an error result")
  );
}

function toRuntimeEvent(message: ClaudeStreamMessage): RuntimeEvent | null {
  if (message.type === "result") {
    return {
      type: `result:${message.subtype ?? "unknown"}`,
      timestamp: new Date().toISOString(),
      level: message.subtype === "success" ? "info" : "error",
      message:
        message.subtype === "success"
          ? "Claude query completed"
          : `Claude query ended with subtype ${message.subtype ?? "unknown"}`,
      data: {
        subtype: message.subtype ?? null,
      },
    };
  }

  if (message.type === "system" && message.subtype === "init") {
    return {
      type: "system:init",
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "Claude runtime session initialized",
      data: {
        sessionId: typeof message.session_id === "string" ? message.session_id : null,
      },
    };
  }

  if (message.type === "tool_use_summary" && typeof message.summary === "string") {
    return {
      type: "tool:summary",
      timestamp: new Date().toISOString(),
      level: "info",
      message: message.summary,
    };
  }

  return null;
}

function extractStreamingText(message: ClaudeStreamMessage): string {
  if (message.type !== "stream_event") return "";
  if (message.event?.type !== "content_block_delta") return "";
  if (message.event?.delta?.type !== "text_delta") return "";
  return typeof message.event.delta.text === "string" ? message.event.delta.text : "";
}

function mergeSystemPromptAppend(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): string {
  const values = [input.systemPrompt, execution.systemPromptAppend]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return values.join("\n\n");
}

function resolveEnvironment(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): Record<string, string> {
  const base: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    ...(execution.environment ?? {}),
  };

  const optionRecord = toRecord(input.options);
  const apiKey = typeof optionRecord?.apiKey === "string" ? optionRecord.apiKey : null;
  const apiKeyEnvVar =
    typeof optionRecord?.apiKeyEnvVar === "string" ? optionRecord.apiKeyEnvVar : null;
  const baseUrl = typeof optionRecord?.baseUrl === "string" ? optionRecord.baseUrl : null;

  if (apiKey && apiKeyEnvVar) {
    base[apiKeyEnvVar] = apiKey;
  }
  if (baseUrl) {
    if ((input.providerId ?? "").toLowerCase() === "anthropic") {
      base.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      base.OPENAI_BASE_URL = baseUrl;
    }
  }

  return base;
}

function buildClaudeQueryOptions(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): Record<string, unknown> {
  const hooks = buildClaudeHooks({
    postToolUseHooks: execution.postToolUseHooks,
    subagentStartHooks: execution.subagentStartHooks,
  });

  const mergedAppend = mergeSystemPromptAppend(input, execution);
  const settings = execution.settings ?? { attribution: { commit: "", pr: "" } };
  const options: Record<string, unknown> = {
    ...(execution.abortController ? { abortController: execution.abortController } : {}),
    cwd: input.cwd ?? input.projectRoot,
    env: resolveEnvironment(input, execution),
    settings,
    settingSources: execution.settingSources ?? ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(mergedAppend ? { append: mergedAppend } : {}),
    },
    permissionMode: execution.permissionMode ?? "acceptEdits",
    ...(execution.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(execution.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: execution.pathToClaudeCodeExecutable }
      : {}),
    ...(execution.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(execution.maxTurns != null ? { maxTurns: execution.maxTurns } : {}),
    ...(execution.maxBudgetUsd != null ? { maxBudgetUsd: execution.maxBudgetUsd } : {}),
    ...(execution.stderr ? { stderr: execution.stderr } : {}),
    ...(hooks ? { hooks } : {}),
    ...(execution.agentDefinitionName
      ? {
          extraArgs: {
            agent: execution.agentDefinitionName,
          },
        }
      : {}),
    ...(input.resume && input.sessionId ? { resume: input.sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
  };
  return options;
}

function parseExecutionOptions(
  metadata: Record<string, unknown> | undefined,
): ClaudeRuntimeExecutionOptions {
  if (!metadata) return {};
  const maxBudgetUsd =
    typeof metadata.maxBudgetUsd === "number"
      ? metadata.maxBudgetUsd
      : metadata.maxBudgetUsd === null
        ? null
        : undefined;
  return {
    maxBudgetUsd,
    agentDefinitionName:
      typeof metadata.agentDefinitionName === "string" ? metadata.agentDefinitionName : undefined,
    permissionMode:
      typeof metadata.permissionMode === "string" ? metadata.permissionMode : undefined,
    allowDangerouslySkipPermissions:
      typeof metadata.allowDangerouslySkipPermissions === "boolean"
        ? metadata.allowDangerouslySkipPermissions
        : undefined,
    pathToClaudeCodeExecutable:
      typeof metadata.pathToClaudeCodeExecutable === "string"
        ? metadata.pathToClaudeCodeExecutable
        : undefined,
    settingSources: Array.isArray(metadata.settingSources)
      ? metadata.settingSources.filter((value): value is string => typeof value === "string")
      : undefined,
    settings: toRecord(metadata.settings) as ClaudeRuntimeExecutionOptions["settings"],
    systemPromptAppend:
      typeof metadata.systemPromptAppend === "string" ? metadata.systemPromptAppend : undefined,
    postToolUseHooks: Array.isArray(metadata.postToolUseHooks)
      ? (metadata.postToolUseHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    subagentStartHooks: Array.isArray(metadata.subagentStartHooks)
      ? (metadata.subagentStartHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    includePartialMessages:
      typeof metadata.includePartialMessages === "boolean"
        ? metadata.includePartialMessages
        : undefined,
    maxTurns: typeof metadata.maxTurns === "number" ? metadata.maxTurns : undefined,
    queryStartTimeoutMs:
      typeof metadata.queryStartTimeoutMs === "number" ? metadata.queryStartTimeoutMs : undefined,
    queryStartRetryDelayMs:
      typeof metadata.queryStartRetryDelayMs === "number"
        ? metadata.queryStartRetryDelayMs
        : undefined,
    environment: toStringRecord(toRecord(metadata.environment)),
    stderr:
      typeof metadata.stderr === "function"
        ? (metadata.stderr as (chunk: string) => void)
        : undefined,
    onEvent:
      typeof metadata.onEvent === "function"
        ? (metadata.onEvent as (event: RuntimeEvent) => void)
        : undefined,
    abortController:
      metadata.abortController instanceof AbortController ? metadata.abortController : undefined,
  };
}

function resolveQueryImplementation(): typeof query {
  const runtimeGlobal = globalThis as RuntimeGlobalWithQueryMock;
  if (typeof runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__ === "function") {
    return runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__;
  }
  return query;
}

async function runClaudeQueryAttempt(
  internal: ClaudeRuntimeRunInternalInput,
  timeoutMs: number,
): Promise<ClaudeRuntimeRunAttemptResult> {
  const options = buildClaudeQueryOptions(internal.input, internal.execution);
  const queryImpl = resolveQueryImplementation();
  const stream = queryImpl({
    prompt: internal.input.prompt,
    options,
  });

  const iterator = stream[Symbol.asyncIterator]();
  const timeoutError = makeQueryStartTimeoutError(timeoutMs);
  let sessionId: string | null = internal.input.sessionId ?? null;
  let outputText = "";
  let usage: RuntimeUsage | null = null;
  const events: RuntimeEvent[] = [];
  let terminalErrorSubtype: string | null = null;
  let terminalErrorDetail: string | null = null;

  const processMessage = (rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== "object" || !("type" in rawMessage)) return;
    const message = rawMessage as ClaudeStreamMessage;

    const runtimeEvent = toRuntimeEvent(message);
    if (runtimeEvent) {
      events.push(runtimeEvent);
      internal.execution.onEvent?.(runtimeEvent);
    }

    if (message.type === "system" && message.subtype === "init" && message.session_id) {
      sessionId = message.session_id;
      return;
    }

    const streamedText = extractStreamingText(message);
    if (streamedText) {
      outputText += streamedText;
      const streamEvent: RuntimeEvent = {
        type: "stream:text",
        timestamp: new Date().toISOString(),
        level: "debug",
        message: streamedText,
        data: {
          text: streamedText,
        },
      };
      events.push(streamEvent);
      internal.execution.onEvent?.(streamEvent);
      return;
    }

    if (message.type !== "result") return;

    usage = normalizeUsage(message);
    const directResult = typeof message.result === "string" ? message.result : "";
    if (message.subtype !== "success") {
      terminalErrorSubtype = message.subtype ?? "unknown";
      terminalErrorDetail = directResult || null;
      if (directResult) {
        throw classifyClaudeResultSubtype(terminalErrorSubtype, directResult);
      }
      return;
    }

    if (!outputText && directResult) {
      outputText = directResult;
    }
  };

  try {
    const firstEntry = await Promise.race<IteratorResult<unknown>>([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);

    if (!firstEntry.done) {
      processMessage(firstEntry.value);
    }

    for await (const message of stream) {
      processMessage(message);
    }
  } catch (error) {
    try {
      await iterator.return?.();
    } catch {
      // best-effort stream cleanup
    }
    throw error;
  }

  if (terminalErrorSubtype) {
    throw classifyClaudeResultSubtype(terminalErrorSubtype, terminalErrorDetail);
  }

  return {
    outputText,
    sessionId,
    events,
    usage,
  };
}

export async function runClaudeRuntime(
  input: RuntimeRunInput,
  logger: ClaudeRuntimeRunLogger,
): Promise<RuntimeRunResult> {
  const execution = parseExecutionOptions(input.metadata);
  const timeoutMs = Math.max(execution.queryStartTimeoutMs ?? 60_000, 1);
  const retryDelayMs = Math.max(execution.queryStartRetryDelayMs ?? 1_000, 0);

  logger.info(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      workflowKind: input.workflowKind ?? null,
      profileId: input.profileId ?? null,
      model: input.model ?? null,
      resume: Boolean(input.resume && input.sessionId),
      hasAgentDefinitionName: Boolean(execution.agentDefinitionName),
      maxBudgetUsd: execution.maxBudgetUsd ?? null,
    },
    "Starting Claude runtime run",
  );

  try {
    const attempt = await runClaudeQueryAttempt({ input, execution, logger }, timeoutMs);
    logger.info(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        hasSessionId: Boolean(attempt.sessionId),
      },
      "Claude runtime run completed",
    );
    return {
      outputText: attempt.outputText,
      sessionId: attempt.sessionId,
      events: attempt.events,
      usage: attempt.usage,
    };
  } catch (error) {
    if (input.resume && input.sessionId && isRetryableResumeFailure(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          resumeSessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Claude runtime resume attempt failed, retrying without resume",
      );
      try {
        const resumedFromScratch = await runClaudeQueryAttempt(
          {
            input: {
              ...input,
              resume: false,
              sessionId: null,
            },
            execution,
            logger,
          },
          timeoutMs,
        );
        return {
          outputText: resumedFromScratch.outputText,
          sessionId: resumedFromScratch.sessionId,
          events: resumedFromScratch.events,
          usage: resumedFromScratch.usage,
        };
      } catch (resumeRetryError) {
        const classified = classifyClaudeRuntimeError(resumeRetryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            code: classified.adapterCode,
            error: classified.message,
          },
          "Claude runtime run failed after missing-session resume retry",
        );
        throw classified;
      }
    }

    if (isQueryStartTimeoutError(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          timeoutMs,
        },
        "Claude runtime query_start_timeout detected, retrying once",
      );
      await sleep(retryDelayMs);
      try {
        const retried = await runClaudeQueryAttempt({ input, execution, logger }, timeoutMs);
        return {
          outputText: retried.outputText,
          sessionId: retried.sessionId,
          events: retried.events,
          usage: retried.usage,
        };
      } catch (retryError) {
        const classified = classifyClaudeRuntimeError(retryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            code: classified.adapterCode,
            error: classified.message,
          },
          "Claude runtime run failed after retry",
        );
        throw classified;
      }
    }

    const classified = classifyClaudeRuntimeError(error);
    logger.error(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        code: classified.adapterCode,
        error: classified.message,
      },
      "Claude runtime run failed",
    );
    throw classified;
  }
}
