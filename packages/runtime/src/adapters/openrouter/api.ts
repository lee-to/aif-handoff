import type {
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeUsage,
} from "../../types.js";
import { RuntimeExecutionError } from "../../errors.js";
import { isRetriableTimeoutError, resolveRetryDelay, sleepMs } from "../../timeouts.js";
import { classifyOpenRouterRuntimeError } from "./errors.js";

export interface OpenRouterApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_APP_TITLE = "AIF Handoff";
const RETRYABLE_STATUS = new Set([429]);
const MAX_429_ATTEMPTS = 3;

const SENSITIVE_OPTION_KEYS = new Set(["apiKey", "apikey", "api_key", "secret", "password"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripSensitiveOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return options;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!SENSITIVE_OPTION_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// URL / Auth / Header resolution
// ---------------------------------------------------------------------------

function resolveBaseUrl(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  const baseUrl =
    readString(options.baseUrl) ?? readString(process.env.OPENROUTER_BASE_URL) ?? DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

function resolveApiKey(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.apiKey) ?? readString(process.env.OPENROUTER_API_KEY);
}

function resolveHttpReferer(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.httpReferer) ?? readString(process.env.OPENROUTER_HTTP_REFERER) ?? "";
}

function resolveAppTitle(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return (
    readString(options.appTitle) ??
    readString(process.env.OPENROUTER_APP_TITLE) ??
    DEFAULT_APP_TITLE
  );
}

function buildHeaders(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = resolveApiKey(input);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const referer = resolveHttpReferer(input);
  if (referer) {
    headers.set("HTTP-Referer", referer);
  }
  const appTitle = resolveAppTitle(input);
  if (appTitle) {
    headers.set("X-Title", appTitle);
  }

  const rawHeaders = asRecord(asRecord((input as RuntimeRunInput).options).headers);
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Request body builders
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function buildMessages(input: RuntimeRunInput): ChatMessage[] {
  const messages: ChatMessage[] = [];

  let systemContent = input.systemPrompt ?? "";
  if (input.execution?.systemPromptAppend) {
    systemContent = systemContent
      ? `${systemContent}\n\n${input.execution.systemPromptAppend}`
      : input.execution.systemPromptAppend;
  }
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  messages.push({ role: "user", content: input.prompt });
  return messages;
}

const OPENROUTER_EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"] as const);

type OpenRouterEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeOpenRouterEffort(value: unknown): OpenRouterEffortLevel | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (OPENROUTER_EFFORT_LEVELS.has(trimmed as OpenRouterEffortLevel)) {
      return trimmed as OpenRouterEffortLevel;
    }
  }
  return null;
}

function buildRequestBody(input: RuntimeRunInput, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: buildMessages(input),
    stream,
  };

  if (input.execution?.outputSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: input.execution.outputSchema,
      },
    };
  }

  const options = asRecord(input.options);
  const effort = normalizeOpenRouterEffort(options.effort);
  if (effort) {
    body.reasoning = { effort };
  }

  return body;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(usage: unknown): RuntimeUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const parsed = usage as Record<string, unknown>;
  const inputTokens = (parsed.prompt_tokens as number) ?? (parsed.inputTokens as number) ?? 0;
  const outputTokens = (parsed.completion_tokens as number) ?? (parsed.outputTokens as number) ?? 0;
  const totalTokens =
    (parsed.total_tokens as number) ?? (parsed.totalTokens as number) ?? inputTokens + outputTokens;
  const costUsd =
    typeof parsed.cost === "number"
      ? parsed.cost
      : typeof parsed.costUsd === "number"
        ? parsed.costUsd
        : undefined;
  return { inputTokens, outputTokens, totalTokens, costUsd };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs)) return null;
  return Math.max(0, atMs - Date.now());
}

function getBackoffMs(attempt: number): number {
  // 1.5s, 3.0s for retries #1 and #2
  return 1_500 * attempt;
}

function buildRunTimeoutSignal(input: RuntimeRunInput): AbortSignal | undefined {
  const runMs = input.execution?.runTimeoutMs;
  const externalAbort = input.execution?.abortController;

  const signals: AbortSignal[] = [];
  if (typeof runMs === "number" && Number.isFinite(runMs) && runMs > 0) {
    signals.push(AbortSignal.timeout(Math.floor(runMs)));
  }
  if (externalAbort) {
    signals.push(externalAbort.signal);
  }

  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function isAbortTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function postChatCompletionsWith429Retry(
  input: RuntimeRunInput,
  url: string,
  stream: boolean,
  logger?: OpenRouterApiLogger,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_429_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(input),
      body: JSON.stringify(buildRequestBody(input, stream)),
      ...(signal ? { signal } : {}),
    });

    const isRetryable = RETRYABLE_STATUS.has(response.status);
    const hasAttemptsLeft = attempt < MAX_429_ATTEMPTS;
    if (!isRetryable || !hasAttemptsLeft) {
      return response;
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    const backoffMs = retryAfterMs ?? getBackoffMs(attempt);
    const rawText = await response.text();

    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        model: input.model ?? null,
        status: response.status,
        attempt,
        nextAttempt: attempt + 1,
        retryAfterMs: backoffMs,
        retryAfterHeader: retryAfterHeader ?? null,
        errorPreview: rawText.slice(0, 240),
      },
      "OpenRouter returned retryable 429, retrying request",
    );

    await sleep(backoffMs);
  }

  throw new Error("Unreachable: 429 retry loop exhausted");
}

// ---------------------------------------------------------------------------
// Non-streaming run
// ---------------------------------------------------------------------------

export async function runOpenRouterApi(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;
  const signal = buildRunTimeoutSignal(input);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
      model: input.model ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "Starting OpenRouter API run",
  );

  try {
    const response = await postChatCompletionsWith429Retry(input, url, false, logger, signal);

    const rawText = await response.text();
    if (!response.ok) {
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(rawText || "OpenRouter request failed"),
          response.status,
        ),
      );
    }

    const payload = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const outputText = choice?.message?.content ?? "";

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        hasOutput: outputText.length > 0,
        usage: payload.usage ?? null,
      },
      "OpenRouter API run completed",
    );

    return {
      outputText,
      sessionId: payload.id ?? null,
      usage: normalizeUsage(payload.usage),
      raw: payload,
    };
  } catch (error) {
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: OpenRouter API request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Streaming run (SSE)
// ---------------------------------------------------------------------------

async function runOpenRouterStreamingAttempt(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;
  const signal = buildRunTimeoutSignal(input);

  const response = await postChatCompletionsWith429Retry(input, url, true, logger, signal);

  if (!response.ok) {
    const rawText = await response.text();
    throw classifyOpenRouterRuntimeError(
      new Error(rawText || "OpenRouter streaming request failed"),
      response.status,
    );
  }

  if (!response.body) {
    throw classifyOpenRouterRuntimeError(new Error("OpenRouter streaming response has no body"));
  }

  let outputText = "";
  let sessionId: string | null = null;
  let usage: RuntimeUsage | null = null;
  const events: RuntimeEvent[] = [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkReceived = false;

  // Start timeout — detect hung stream after connection is established
  const startMs = input.execution?.startTimeoutMs;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimedOut = false;

  if (typeof startMs === "number" && Number.isFinite(startMs) && startMs > 0) {
    startTimer = setTimeout(() => {
      startTimedOut = true;
      reader.cancel().catch(() => {});
    }, startMs);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          if (!sessionId && parsed.id) {
            sessionId = parsed.id;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            outputText += delta.content;
            const event: RuntimeEvent = {
              type: "stream:text",
              timestamp: new Date().toISOString(),
              message: delta.content,
            };
            events.push(event);
            input.execution?.onEvent?.(event);
          }

          if (parsed.usage) {
            usage = normalizeUsage(parsed.usage);
          }
        } catch {
          logger?.debug?.(
            { runtimeId: input.runtimeId, rawLine: trimmed },
            "Failed to parse SSE chunk, skipping",
          );
        }
      }
    }
  } finally {
    if (startTimer) clearTimeout(startTimer);
    reader.releaseLock();
  }

  if (startTimedOut) {
    const err = new RuntimeExecutionError(
      `Start timeout: OpenRouter streaming produced no data within ${startMs}ms`,
      undefined,
      "timeout",
    );
    (err as unknown as Record<string, unknown>).__timeoutRetriable__ = true;
    throw err;
  }

  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      outputLength: outputText.length,
      eventCount: events.length,
    },
    "OpenRouter API streaming run completed",
  );

  return {
    outputText,
    sessionId,
    usage,
    events,
    raw: { streaming: true, eventCount: events.length },
  };
}

export async function runOpenRouterApiStreaming(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      model: input.model ?? null,
      streaming: true,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
    },
    "Starting OpenRouter API streaming run",
  );

  try {
    return await runOpenRouterStreamingAttempt(input, logger);
  } catch (error) {
    if (isRetriableTimeoutError(error)) {
      const retryDelayMs = resolveRetryDelay(input.execution ?? {});
      logger?.warn?.(
        { runtimeId: input.runtimeId, retryDelayMs },
        "OpenRouter streaming start timeout, retrying once after delay",
      );
      await sleepMs(retryDelayMs);
      return runOpenRouterStreamingAttempt(input, logger);
    }
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: OpenRouter streaming request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Connection validation
// ---------------------------------------------------------------------------

export async function validateOpenRouterApiConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/models`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(input),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `OpenRouter health check failed with status ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "OpenRouter API connection validated",
    };
  } catch (error) {
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

export async function listOpenRouterApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
): Promise<RuntimeModel[]> {
  const inputWithOptions = input as RuntimeConnectionValidationInput;
  const baseUrl = resolveBaseUrl(inputWithOptions);
  const url = `${baseUrl}/models`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(inputWithOptions),
    });
    if (!response.ok) {
      const rawText = await response.text();
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(rawText || "OpenRouter model listing failed"),
          response.status,
        ),
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    const models = payload.data ?? [];
    return models.map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      supportsStreaming: true,
      metadata: {
        contextLength: model.context_length,
        pricing: model.pricing,
      },
    }));
  } catch (error) {
    throw classifyOpenRouterRuntimeError(error);
  }
}
