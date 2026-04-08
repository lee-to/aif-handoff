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
import { classifyCodexRuntimeError } from "./errors.js";

export interface CodexAgentApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

const DEFAULT_API_RETRY_COUNT = 2;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type CodexApiInput = RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput;

const SENSITIVE_OPTION_KEYS = new Set(["apiKey", "apikey", "api_key", "secret", "password"]);

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

function resolveApiKeyEnvVar(input: CodexApiInput): string {
  const options = asRecord(input.options);
  const topLevelApiKeyEnvVar = "apiKeyEnvVar" in input ? readString(input.apiKeyEnvVar) : null;
  return topLevelApiKeyEnvVar ?? readString(options.apiKeyEnvVar) ?? "OPENAI_API_KEY";
}

function resolveBaseUrl(input: CodexApiInput): string {
  const options = asRecord(input.options);
  const baseUrl =
    ("baseUrl" in input ? readString(input.baseUrl) : null) ??
    readString(options.agentApiBaseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.OPENAI_BASE_URL);
  if (!baseUrl) {
    throw classifyCodexRuntimeError("Codex API transport requires baseUrl or OPENAI_BASE_URL");
  }
  return baseUrl.replace(/\/+$/, "");
}

function resolveApiKey(input: CodexApiInput): string | null {
  const options = asRecord(input.options);
  const apiKeyEnvVar = resolveApiKeyEnvVar(input);
  return (
    ("apiKey" in input ? readString(input.apiKey) : null) ??
    readString(options.apiKey) ??
    readString(process.env[apiKeyEnvVar]) ??
    readString(process.env.OPENAI_API_KEY)
  );
}

function buildHeaders(input: CodexApiInput): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = resolveApiKey(input);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const rawHeaders = {
    ...asRecord(asRecord(input.options).headers),
    ...("headers" in input ? asRecord(input.headers) : {}),
  };
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

function resolveApiRetryCount(input: RuntimeRunInput): number {
  const options = asRecord(input.options);
  const fromOptions = options.apiRetryCount;
  const fromEnv = process.env.CODEX_API_RETRY_COUNT;
  const raw =
    typeof fromOptions === "number"
      ? fromOptions
      : typeof fromOptions === "string"
        ? Number.parseInt(fromOptions, 10)
        : fromEnv
          ? Number.parseInt(fromEnv, 10)
          : DEFAULT_API_RETRY_COUNT;

  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_API_RETRY_COUNT;
  }
  return Math.floor(raw);
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function isRetryableFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("fetch failed") ||
    lowered.includes("network") ||
    lowered.includes("econnreset") ||
    lowered.includes("econnrefused") ||
    lowered.includes("timed out") ||
    lowered.includes("etimedout")
  );
}

function retryBackoffMs(attempt: number): number {
  return 150 * (attempt + 1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(
  input: RuntimeRunInput,
  url: string,
  init: RequestInit,
  logger: CodexAgentApiLogger | undefined,
  requestType: "non-stream" | "stream",
): Promise<Response> {
  const maxRetries = resolveApiRetryCount(input);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        const delayMs = retryBackoffMs(attempt);
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            status: response.status,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            requestType,
          },
          "OpenAI API returned retryable status, retrying",
        );
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < maxRetries && isRetryableFetchError(error)) {
        const delayMs = retryBackoffMs(attempt);
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            error: error instanceof Error ? error.message : String(error),
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            requestType,
          },
          "OpenAI API request failed with retryable transport error, retrying",
        );
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Messages & request body (OpenAI Chat Completions format)
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

// ---------------------------------------------------------------------------
// Non-streaming run (OpenAI Chat Completions)
// ---------------------------------------------------------------------------

export async function runCodexAgentApi(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
      model: input.model ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "Starting OpenAI API run",
  );

  try {
    const response = await fetchWithRetries(
      input,
      url,
      {
        method: "POST",
        headers: buildHeaders(input),
        body: JSON.stringify(buildRequestBody(input, false)),
      },
      logger,
      "non-stream",
    );

    const rawText = await response.text();
    if (!response.ok) {
      return Promise.reject(
        classifyCodexRuntimeError(new Error(`OpenAI API HTTP ${response.status}: ${rawText}`)),
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
      "OpenAI API run completed",
    );

    return {
      outputText,
      sessionId: payload.id ?? null,
      usage: normalizeUsage(payload.usage),
      raw: payload,
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Streaming run (SSE, OpenAI Chat Completions)
// ---------------------------------------------------------------------------

export async function runCodexAgentApiStreaming(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
      model: input.model ?? null,
      streaming: true,
    },
    "Starting OpenAI API streaming run",
  );

  try {
    const response = await fetchWithRetries(
      input,
      url,
      {
        method: "POST",
        headers: buildHeaders(input),
        body: JSON.stringify(buildRequestBody(input, true)),
      },
      logger,
      "stream",
    );

    if (!response.ok) {
      const rawText = await response.text();
      return Promise.reject(
        classifyCodexRuntimeError(new Error(`OpenAI API HTTP ${response.status}: ${rawText}`)),
      );
    }

    if (!response.body) {
      return Promise.reject(
        classifyCodexRuntimeError(new Error("OpenAI API streaming response has no body")),
      );
    }

    let outputText = "";
    let sessionId: string | null = null;
    let usage: RuntimeUsage | null = null;
    const events: RuntimeEvent[] = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

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
      reader.releaseLock();
    }

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        outputLength: outputText.length,
        eventCount: events.length,
      },
      "OpenAI API streaming run completed",
    );

    return {
      outputText,
      sessionId,
      usage,
      events,
      raw: { streaming: true, eventCount: events.length },
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Connection validation
// ---------------------------------------------------------------------------

export async function validateCodexAgentApiConnection(
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
        message: `OpenAI API health check failed with status ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "OpenAI API connection validated",
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

export async function listCodexAgentApiModels(
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
      return Promise.reject(
        classifyCodexRuntimeError(
          new Error(`OpenAI API model listing failed with status ${response.status}`),
        ),
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        owned_by?: string;
      }>;
    };
    const models = payload.data ?? [];
    return models.map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      supportsStreaming: true,
      metadata: { owned_by: model.owned_by },
    }));
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}
