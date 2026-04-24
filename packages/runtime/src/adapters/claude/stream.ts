import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeLimitSnapshot,
  RuntimeRunInput,
  RuntimeUsage,
} from "../../types.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { withStreamTimeouts } from "../../timeouts.js";
import { classifyClaudeResultSubtype } from "./errors.js";
import type { ClaudeOptionsLogger, ClaudeRuntimeExecutionOptions } from "./options.js";
import { buildClaudeQueryOptions } from "./options.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { normalizeClaudeLimitSnapshot } from "./limit.js";
import { parseClaudeAskUserQuestion } from "./questions.js";
import { resolveClaudeProviderAuth } from "./providerIdentity.js";
import { fetchZaiClaudeQuotaSnapshot } from "./zaiQuota.js";

const QUERY_START_TIMEOUT_CODE = "query_start_timeout";

interface QueryStartTimeoutError extends Error {
  code: typeof QUERY_START_TIMEOUT_CODE;
}

interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  rate_limit_info?: unknown;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  summary?: string;
  [key: string]: unknown;
}

interface RuntimeGlobalWithQueryMock {
  __AIF_CLAUDE_QUERY_MOCK__?: typeof query;
}

export interface ClaudeQueryAttemptResult {
  outputText: string;
  sessionId: string | null;
  events: RuntimeEvent[];
  usage: RuntimeUsage | null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
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

function buildClaudeLimitErrorMetadata(snapshot: RuntimeLimitSnapshot | null) {
  const retryAfterSeconds = snapshot?.retryAfterSeconds ?? null;
  return {
    resetAt: snapshot?.resetAt ?? null,
    retryAfterSeconds,
    retryAfterMs: retryAfterSeconds != null ? retryAfterSeconds * 1000 : null,
    limitSnapshot: snapshot,
    providerMeta: snapshot?.providerMeta ?? null,
  };
}

function toRuntimeEvent(message: ClaudeStreamMessage): RuntimeEvent | null {
  if (message.type === "result") {
    return {
      type: `result:${message.subtype ?? "unknown"}`,
      timestamp: new Date().toISOString(),
      level: message.subtype === "success" ? "info" : "error",
      message:
        message.subtype === "success"
          ? "Query completed"
          : `Query ended with subtype ${message.subtype ?? "unknown"}`,
      data: { subtype: message.subtype ?? null },
    };
  }

  if (message.type === "system" && message.subtype === "init") {
    return {
      type: "system:init",
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "Runtime session initialized",
      data: { sessionId: typeof message.session_id === "string" ? message.session_id : null },
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

interface AssistantContentItem {
  type?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

function extractAssistantToolUses(message: ClaudeStreamMessage): AssistantContentItem[] {
  if (message.type !== "assistant") return [];
  const rawMessage = (message as Record<string, unknown>).message;
  if (!rawMessage || typeof rawMessage !== "object") return [];
  const content = (rawMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is AssistantContentItem => {
      if (!item || typeof item !== "object") return false;
      return (item as { type?: string }).type === "tool_use";
    })
    .filter((item) => typeof item.name === "string");
}

export function makeQueryStartTimeoutError(timeoutMs: number): QueryStartTimeoutError {
  const error = new Error(
    `query_start_timeout: runtime produced no output within ${timeoutMs}ms`,
  ) as QueryStartTimeoutError;
  error.code = QUERY_START_TIMEOUT_CODE;
  return error;
}

export function isQueryStartTimeoutError(error: unknown): error is QueryStartTimeoutError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === QUERY_START_TIMEOUT_CODE,
  );
}

function resolveQueryImplementation(): typeof query {
  if (process.env.NODE_ENV === "test") {
    const runtimeGlobal = globalThis as RuntimeGlobalWithQueryMock;
    if (typeof runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__ === "function") {
      return runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__;
    }
  }
  return query;
}

/** Execute a single Claude Agent SDK query attempt, consuming the async stream. */
export async function runClaudeQueryAttempt(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
  logger?: ClaudeOptionsLogger,
): Promise<ClaudeQueryAttemptResult> {
  const { identity: providerIdentity, authToken } = resolveClaudeProviderAuth({
    providerId: input.providerId ?? "anthropic",
    transport: input.transport ?? "sdk",
    baseUrl: typeof input.options?.baseUrl === "string" ? input.options.baseUrl : null,
    apiKeyEnvVar:
      typeof input.options?.apiKeyEnvVar === "string" ? input.options.apiKeyEnvVar : null,
    apiKey: typeof input.options?.apiKey === "string" ? input.options.apiKey : null,
  });
  const options = buildClaudeQueryOptions(input, execution, logger);
  const queryImpl = resolveQueryImplementation();
  const stream = queryImpl({ prompt: input.prompt, options });

  const rawIterator = stream[Symbol.asyncIterator]();

  // Wrap with shared timeout utilities — start + run timeout
  const abort = execution.abortController ?? new AbortController();
  const iterator = withStreamTimeouts(
    rawIterator,
    {
      startTimeoutMs: execution.queryStartTimeoutMs,
      runTimeoutMs: execution.runTimeoutMs,
    },
    abort,
  );

  let sessionId: string | null = input.sessionId ?? null;
  let outputText = "";
  let usage: RuntimeUsage | null = null;
  const events: RuntimeEvent[] = [];
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  let terminalErrorSubtype: string | null = null;
  let terminalErrorDetail: string | null = null;

  const processMessage = (rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== "object" || !("type" in rawMessage)) return;
    const message = rawMessage as ClaudeStreamMessage;

    const runtimeEvent = toRuntimeEvent(message);
    if (runtimeEvent) {
      events.push(runtimeEvent);
      execution.onEvent?.(runtimeEvent);
    }

    if (message.type === "rate_limit_event") {
      const snapshot = normalizeClaudeLimitSnapshot({
        info: message.rate_limit_info,
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        checkedAt: new Date().toISOString(),
        providerIdentity,
      });

      if (!snapshot) {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            providerId: input.providerId ?? "anthropic",
            profileId: input.profileId ?? null,
          },
          "Dropped Claude rate_limit_event because it did not contain usable limit metadata",
        );
        return;
      }

      latestLimitSnapshot = snapshot;
      const limitEvent = buildRuntimeLimitEvent(snapshot, "rate_limit_event");
      events.push(limitEvent);
      execution.onEvent?.(limitEvent);
      logger?.debug?.(
        {
          runtimeId: input.runtimeId,
          providerId: snapshot.providerId,
          profileId: snapshot.profileId ?? null,
          status: snapshot.status,
          precision: snapshot.precision,
          source: snapshot.source,
          resetAt: snapshot.resetAt ?? null,
        },
        "Translated Claude rate_limit_event into runtime limit snapshot",
      );
      return;
    }

    if (message.type === "system" && message.subtype === "init" && message.session_id) {
      sessionId = message.session_id;
      return;
    }

    const toolUses = extractAssistantToolUses(message);
    if (toolUses.length > 0) {
      const nowIso = new Date().toISOString();
      for (const item of toolUses) {
        const toolName = item.name as string;
        const toolUseId = typeof item.id === "string" ? item.id : null;
        const toolUseEvents = buildToolUseEvents({
          toolName,
          toolUseId,
          input: item.input,
          timestamp: nowIso,
          questionPayload: parseClaudeAskUserQuestion(toolName, toolUseId, item.input),
        });
        for (const event of toolUseEvents) {
          events.push(event);
          execution.onEvent?.(event);
        }
      }
    }

    const streamedText = extractStreamingText(message);
    if (streamedText) {
      outputText += streamedText;
      const streamEvent: RuntimeEvent = {
        type: "stream:text",
        timestamp: new Date().toISOString(),
        level: "debug",
        message: streamedText,
        data: { text: streamedText },
      };
      events.push(streamEvent);
      execution.onEvent?.(streamEvent);
      return;
    }

    if (message.type !== "result") return;

    usage = normalizeUsage(message);
    const directResult = typeof message.result === "string" ? message.result : "";
    if (message.subtype !== "success") {
      terminalErrorSubtype = message.subtype ?? "unknown";
      terminalErrorDetail = directResult || null;
      if (directResult) {
        throw classifyClaudeResultSubtype(
          terminalErrorSubtype,
          directResult,
          buildClaudeLimitErrorMetadata(latestLimitSnapshot),
        );
      }
      return;
    }

    if (!outputText && directResult) {
      outputText = directResult;
    }
  };

  for await (const value of iterator) {
    processMessage(value);
  }

  if (providerIdentity.quotaSource === "zai_monitor" && authToken) {
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        quotaAuthEnvVar: providerIdentity.apiKeyEnvVar,
        providerFamily: providerIdentity.providerFamily,
      },
      "Refreshing Z.AI coding quota snapshot with resolved Claude auth identity",
    );
    try {
      const providerSnapshot = await fetchZaiClaudeQuotaSnapshot({
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        identity: providerIdentity,
        authToken,
        logger,
      });
      if (providerSnapshot) {
        latestLimitSnapshot = providerSnapshot;
        const providerLimitEvent = buildRuntimeLimitEvent(providerSnapshot, "zai_monitor");
        events.push(providerLimitEvent);
        execution.onEvent?.(providerLimitEvent);
      }
    } catch (error) {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? "anthropic",
          profileId: input.profileId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh Z.AI coding quota snapshot after Claude runtime run",
      );
    }
  }

  if (terminalErrorSubtype) {
    throw classifyClaudeResultSubtype(
      terminalErrorSubtype,
      terminalErrorDetail,
      buildClaudeLimitErrorMetadata(latestLimitSnapshot),
    );
  }

  return { outputText, sessionId, events, usage };
}
