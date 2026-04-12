import {
  RuntimeTransport,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDiagnoseErrorInput,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "../../types.js";
import {
  listOpenRouterApiModels,
  runOpenRouterApi,
  runOpenRouterApiStreaming,
  validateOpenRouterApiConnection,
  type OpenRouterApiLogger,
} from "./api.js";
import { classifyOpenRouterRuntimeError } from "./errors.js";

export type OpenRouterAdapterLogger = OpenRouterApiLogger & {
  error?(context: Record<string, unknown>, message: string): void;
};

export interface CreateOpenRouterRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: OpenRouterAdapterLogger;
}

const DEFAULT_OPENROUTER_MODELS: RuntimeModel[] = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", supportsStreaming: true },
  { id: "openai/gpt-4o", label: "GPT-4o", supportsStreaming: true },
  { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash", supportsStreaming: true },
];

const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  usageReporting: UsageReporting.FULL,
};

function createFallbackLogger(): OpenRouterAdapterLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime:openrouter]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:openrouter]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:openrouter]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:openrouter]", message, context);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();

  if (
    combined.includes("unauthorized") ||
    combined.includes("invalid api key") ||
    combined.includes("401")
  ) {
    return "OpenRouter API key is missing or invalid. Check OPENROUTER_API_KEY environment variable.";
  }
  if (combined.includes("rate limit") || combined.includes("429") || combined.includes("quota")) {
    return "OpenRouter rate limit or quota exceeded. Wait and retry, or check your plan limits at openrouter.ai.";
  }
  if (combined.includes("model not found") || combined.includes("no endpoints found")) {
    return "The requested model is not available on OpenRouter. Check the model ID format (provider/model).";
  }
  if (combined.includes("context_length_exceeded")) {
    return "The prompt exceeds the model's maximum context length. Reduce the input or choose a model with a larger context window.";
  }
  if (combined.includes("connection refused") || combined.includes("fetch failed")) {
    return "Cannot reach OpenRouter API. Check network connectivity and OPENROUTER_BASE_URL.";
  }
  return `OpenRouter error: ${message}`;
}

export function createOpenRouterRuntimeAdapter(
  options: CreateOpenRouterRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "openrouter";
  const providerId = options.providerId ?? "openrouter";
  const logger = options.logger ?? createFallbackLogger();

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "OpenRouter",
      lightModel: null,
      defaultApiKeyEnvVar: "OPENROUTER_API_KEY",
      defaultBaseUrlEnvVar: "OPENROUTER_BASE_URL",
      defaultModelPlaceholder: "anthropic/claude-sonnet-4",
      supportedTransports: [RuntimeTransport.API],
      defaultTransport: RuntimeTransport.API,
      capabilities: API_CAPABILITIES,
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          model: input.model ?? null,
          streaming: Boolean(input.stream !== false && input.execution?.onEvent),
        },
        "OpenRouter adapter run invoked",
      );

      try {
        const useStreaming = input.stream !== false && Boolean(input.execution?.onEvent);
        if (useStreaming) {
          return await runOpenRouterApiStreaming(input, logger);
        }
        return await runOpenRouterApi(input, logger);
      } catch (error) {
        throw classifyOpenRouterRuntimeError(error);
      }
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const options = asRecord(input.options);
      const apiKey = readString(options.apiKey) ?? readString(process.env.OPENROUTER_API_KEY);
      if (!apiKey) {
        return {
          ok: false,
          message: "Missing API key (expected env var: OPENROUTER_API_KEY)",
        };
      }
      return validateOpenRouterApiConnection(input);
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      try {
        const models = await listOpenRouterApiModels(input);
        if (models.length > 0) {
          logger.debug?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              modelCount: models.length,
            },
            "Fetched model list from OpenRouter API",
          );
          return models;
        }
      } catch {
        logger.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
          },
          "OpenRouter model discovery failed, falling back to built-in list",
        );
      }
      logger.debug?.(
        { runtimeId: input.runtimeId, profileId: input.profileId ?? null },
        "Returning built-in OpenRouter model list",
      );
      return DEFAULT_OPENROUTER_MODELS;
    },

    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseErrorMessage(input);
    },
  };
}
