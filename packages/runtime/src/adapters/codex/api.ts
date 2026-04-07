import type {
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
} from "../../types.js";
import { classifyCodexRuntimeError } from "./errors.js";

export interface CodexAgentApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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

function resolveAgentApiBaseUrl(input: RuntimeRunInput | RuntimeConnectionValidationInput): string {
  const options = asRecord(input.options);
  const baseUrl =
    readString(options.agentApiBaseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.AGENTAPI_BASE_URL) ??
    readString(process.env.OPENAI_BASE_URL);
  if (!baseUrl) {
    throw classifyCodexRuntimeError(
      "Codex API transport requires agentApiBaseUrl/baseUrl/AGENTAPI_BASE_URL",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function resolveApiKey(input: RuntimeRunInput | RuntimeConnectionValidationInput): string | null {
  const options = asRecord(input.options);
  return readString(options.apiKey) ?? readString(process.env.OPENAI_API_KEY);
}

function buildHeaders(input: RuntimeRunInput | RuntimeConnectionValidationInput): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = resolveApiKey(input);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const rawHeaders = asRecord(asRecord(input.options).headers);
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

function normalizeUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return null;
  const parsed = usage as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  const inputTokens = parsed.inputTokens ?? 0;
  const outputTokens = parsed.outputTokens ?? 0;
  const totalTokens = parsed.totalTokens ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: parsed.costUsd,
  };
}

export async function runCodexAgentApi(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveAgentApiBaseUrl(input);
  const options = asRecord(input.options);
  const path = readString(options.agentApiRunPath) ?? "/v1/runtime/run";
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
    },
    "Starting Codex AgentAPI run",
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(input),
      body: JSON.stringify({
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId,
        workflowKind: input.workflowKind,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
        resume: input.resume,
        options: stripSensitiveOptions(input.options),
        metadata: input.metadata,
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`AgentAPI HTTP ${response.status}: ${rawText}`);
    }

    const payload = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
    return {
      outputText: payload.outputText ?? payload.result ?? "",
      sessionId: payload.sessionId ?? input.sessionId ?? null,
      usage: normalizeUsage(payload.usage),
      events: Array.isArray(payload.events) ? payload.events : undefined,
      raw: payload,
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

export async function validateCodexAgentApiConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const baseUrl = resolveAgentApiBaseUrl(input);
  const options = asRecord(input.options);
  const path = readString(options.agentApiValidationPath) ?? "/v1/runtime/health";
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(input),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `AgentAPI health check failed with status ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "AgentAPI connection validated",
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

export async function listCodexAgentApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
): Promise<RuntimeModel[]> {
  const inputWithOptions = input as RuntimeConnectionValidationInput;
  const baseUrl = resolveAgentApiBaseUrl(inputWithOptions);
  const options = asRecord(inputWithOptions.options);
  const path = readString(options.agentApiModelsPath) ?? "/v1/models";
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(inputWithOptions),
    });
    if (!response.ok) {
      throw new Error(`AgentAPI model listing failed with status ${response.status}`);
    }
    const payload = (await response.json()) as {
      models?: Array<{
        id: string;
        label?: string;
        supportsStreaming?: boolean;
        metadata?: Record<string, unknown>;
      }>;
      data?: Array<{
        id: string;
        label?: string;
        supportsStreaming?: boolean;
        metadata?: Record<string, unknown>;
      }>;
    };
    const models = payload.models ?? payload.data ?? [];
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      supportsStreaming: model.supportsStreaming,
      metadata: model.metadata,
    }));
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}
