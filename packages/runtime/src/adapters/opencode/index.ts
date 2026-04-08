import {
  RuntimeTransport,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDiagnoseErrorInput,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
  type RuntimeEvent,
} from "../../types.js";
import {
  getOpenCodeSession,
  listOpenCodeApiModels,
  listOpenCodeSessionEvents,
  listOpenCodeSessions,
  runOpenCodeApi,
  validateOpenCodeApiConnection,
  type OpenCodeApiLogger,
} from "./api.js";
import { classifyOpenCodeRuntimeError } from "./errors.js";

export type OpenCodeRuntimeAdapterLogger = OpenCodeApiLogger;

export interface CreateOpenCodeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: OpenCodeRuntimeAdapterLogger;
}

const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
};

const DEFAULT_OPENCODE_MODELS: RuntimeModel[] = [
  {
    id: "anthropic/claude-sonnet-4",
    label: "anthropic/claude-sonnet-4",
    supportsStreaming: true,
  },
  {
    id: "openai/gpt-5.4",
    label: "openai/gpt-5.4",
    supportsStreaming: true,
  },
];

function createFallbackLogger(): OpenCodeRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime:opencode]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:opencode]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:opencode]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:opencode]", message, context);
    },
  };
}

function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();

  if (
    combined.includes("unauthorized") ||
    combined.includes("invalid password") ||
    combined.includes("401") ||
    combined.includes("403")
  ) {
    return "OpenCode server authentication failed. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if customized).";
  }
  if (combined.includes("rate") || combined.includes("429") || combined.includes("quota")) {
    return "OpenCode request was rate-limited. Retry with backoff or reduce request frequency.";
  }
  if (
    combined.includes("timed out") ||
    combined.includes("timeout") ||
    combined.includes("aborted")
  ) {
    return "OpenCode request timed out. Increase timeoutMs or check server responsiveness.";
  }
  if (
    combined.includes("connection refused") ||
    combined.includes("econnrefused") ||
    combined.includes("fetch failed") ||
    combined.includes("network")
  ) {
    return "Cannot reach OpenCode server. Start opencode serve and verify baseUrl/port.";
  }
  if (combined.includes("session") && combined.includes("not found")) {
    return "OpenCode session not found. Create a new session or provide a valid sessionId.";
  }
  if (
    combined.includes("providermodelnotfounderror") ||
    combined.includes("modelnotfounderror") ||
    combined.includes("provider not found") ||
    combined.includes("model not found")
  ) {
    return "OpenCode provider/model is not available. Check GET /config/providers and use an exact providerID/modelID pair from that response.";
  }

  return `OpenCode error: ${message}`;
}

export function createOpenCodeRuntimeAdapter(
  options: CreateOpenCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "opencode";
  const providerId = options.providerId ?? "opencode";
  const logger = options.logger ?? createFallbackLogger();

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "OpenCode",
      supportsProjectInit: true,
      lightModel: null,
      defaultBaseUrlEnvVar: "OPENCODE_BASE_URL",
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
          transport: input.transport ?? RuntimeTransport.API,
          sessionId: input.sessionId ?? null,
          model: input.model ?? null,
          stream: input.stream ?? null,
        },
        "OpenCode adapter run invoked",
      );

      try {
        return await runOpenCodeApi({ ...input, transport: RuntimeTransport.API }, logger);
      } catch (error) {
        logger.error?.(
          {
            runtimeId,
            profileId: input.profileId ?? null,
            error: error instanceof Error ? error.message : String(error),
          },
          "OpenCode adapter run failed",
        );
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          sessionId: input.sessionId,
        },
        "OpenCode adapter resume invoked",
      );

      try {
        return await runOpenCodeApi(
          { ...input, transport: RuntimeTransport.API, resume: true },
          logger,
        );
      } catch (error) {
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listOpenCodeSessions(input, logger);
    },

    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getOpenCodeSession(input, logger);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      return listOpenCodeSessionEvents(input, logger);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      return validateOpenCodeApiConnection({ ...input, transport: RuntimeTransport.API });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      try {
        const models = await listOpenCodeApiModels(input);
        if (models.length > 0) {
          logger.debug?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              modelCount: models.length,
            },
            "Fetched model list from OpenCode API",
          );
          return models;
        }
      } catch {
        logger.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
          },
          "OpenCode model discovery failed, falling back to built-in list",
        );
      }

      return DEFAULT_OPENCODE_MODELS;
    },

    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseErrorMessage(input);
    },
  };
}
