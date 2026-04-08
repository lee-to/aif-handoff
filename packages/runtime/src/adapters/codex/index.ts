import { existsSync } from "node:fs";
import { getCodexMcpStatus, installCodexMcpServer, uninstallCodexMcpServer } from "./mcp.js";
import { initCodexProject } from "./project.js";
import {
  RuntimeTransport,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSessionListInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionEventsInput,
  type RuntimeSession,
  type RuntimeEvent,
} from "../../types.js";
import { runCodexCli, probeCodexCli, type CodexCliLogger } from "./cli.js";
import {
  listCodexAgentApiModels,
  runCodexAgentApi,
  runCodexAgentApiStreaming,
  validateCodexAgentApiConnection,
  type CodexAgentApiLogger,
} from "./api.js";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  listCodexAppServerModels,
} from "./modelDiscovery.js";
import { runCodexSdk, type CodexSdkLogger } from "./sdk.js";
import { listCodexSdkSessions, getCodexSdkSession, listCodexSdkSessionEvents } from "./sessions.js";
import { classifyCodexRuntimeError } from "./errors.js";

export type CodexRuntimeAdapterLogger = CodexCliLogger & CodexAgentApiLogger & CodexSdkLogger;

export interface CreateCodexRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: CodexRuntimeAdapterLogger;
}

function createFallbackLogger(): CodexRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime:codex]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:codex]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:codex]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:codex]", message, context);
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

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

/**
 * Capabilities differ by transport. CLI is the lowest-common-denominator;
 * SDK adds resume and session list; API capabilities depend on the remote.
 */

const CLI_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
};

const SDK_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
};

const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
};

function resolveTransport(input: {
  transport?: string;
  options?: Record<string, unknown>;
}): RuntimeTransport {
  const requested = readString(input.transport) ?? readString(asRecord(input.options).transport);
  if (requested === RuntimeTransport.SDK) return RuntimeTransport.SDK;
  if (requested === RuntimeTransport.API || requested === "agentapi") return RuntimeTransport.API;
  return RuntimeTransport.CLI;
}

function resolveCliPath(input: RuntimeConnectionValidationInput): string | null {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

// ---------------------------------------------------------------------------
// Connection validation per transport
// ---------------------------------------------------------------------------

async function validateCodexCliConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const cliPath = resolveCliPath(input);
  if (!cliPath) {
    return {
      ok: false,
      message: "Codex CLI path is not configured",
    };
  }

  const looksLikePath = cliPath.includes("/") || cliPath.includes("\\");
  if (looksLikePath && !existsSync(cliPath)) {
    return {
      ok: false,
      message: `Configured Codex CLI path does not exist: ${cliPath}`,
    };
  }

  // Actually probe the CLI to verify it's reachable (catches Windows .cmd resolution issues)
  const probe = probeCodexCli(cliPath);
  if (!probe.ok) {
    return {
      ok: false,
      message: `Codex CLI is not reachable (${cliPath}): ${probe.error}`,
    };
  }

  return {
    ok: true,
    message: `Codex CLI ${probe.version ?? "unknown"} (${cliPath})`,
  };
}

async function validateCodexSdkConnection(
  _input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  // SDK internally locates a vendored platform binary from optional deps
  // (e.g. @openai/codex-win32-x64). If that's missing, `new Codex()` will
  // throw at thread start. We probe eagerly by attempting a minimal instantiation.
  try {
    const { Codex } = await import("@openai/codex-sdk");
    // Codex constructor itself may throw if vendored binary is missing
    new Codex({});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("locate") || msg.includes("binaries") || msg.includes("optional")) {
      return {
        ok: false,
        message: `Codex SDK vendor binary not found. Install platform-specific optional dep: ${msg}`,
      };
    }
    // Other import/init errors — SDK itself may not be installed
    return {
      ok: false,
      message: `Codex SDK is not available: ${msg}`,
    };
  }

  return {
    ok: true,
    message: "Codex SDK is available (vendor binary found)",
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createCodexRuntimeAdapter(
  options: CreateCodexRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "codex";
  const providerId = options.providerId ?? "openai";
  const logger = options.logger ?? createFallbackLogger();

  async function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transport = resolveTransport({ transport: input.transport, options: input.options });
    const wantsStreaming = input.execution?.onEvent != null;
    logger.info?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
      },
      "INFO [runtime:codex] Selected transport",
    );

    if (transport === RuntimeTransport.SDK) {
      return runCodexSdk(input, logger);
    }

    if (transport === RuntimeTransport.API) {
      if (wantsStreaming) {
        return runCodexAgentApiStreaming({ ...input, transport }, logger);
      }
      return runCodexAgentApi({ ...input, transport }, logger);
    }

    return runCodexCli({ ...input, transport }, logger);
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Codex",
      supportsProjectInit: true,
      skillCommandPrefix: "$",
      lightModel: null,
      defaultApiKeyEnvVar: "OPENAI_API_KEY",
      defaultBaseUrlEnvVar: "OPENAI_BASE_URL",
      defaultModelPlaceholder: "gpt-5.4",
      supportedTransports: [RuntimeTransport.SDK, RuntimeTransport.CLI, RuntimeTransport.API],
      defaultTransport: RuntimeTransport.CLI,
      capabilities: CLI_CAPABILITIES,
    },

    getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
      switch (transport) {
        case RuntimeTransport.SDK:
          return SDK_CAPABILITIES;
        case RuntimeTransport.API:
          return API_CAPABILITIES;
        default:
          return CLI_CAPABILITIES;
      }
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      try {
        return await runByTransport(input);
      } catch (error) {
        throw classifyCodexRuntimeError(error);
      }
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      try {
        return await runByTransport({ ...input, resume: true });
      } catch (error) {
        throw classifyCodexRuntimeError(error);
      }
    },

    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listCodexSdkSessions(input);
    },

    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getCodexSdkSession(input);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      return listCodexSdkSessionEvents(input);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const rawTransport = readString(input.transport);
      if (
        rawTransport &&
        rawTransport !== RuntimeTransport.CLI &&
        rawTransport !== RuntimeTransport.API &&
        rawTransport !== RuntimeTransport.SDK &&
        rawTransport !== "agentapi"
      ) {
        return {
          ok: false,
          message: `Codex does not support "${rawTransport}" transport. Use "sdk", "cli", or "api".`,
        };
      }

      const transport = resolveTransport({ transport: input.transport, options: input.options });

      if (transport === RuntimeTransport.SDK) {
        return validateCodexSdkConnection(input);
      }

      if (transport === RuntimeTransport.API) {
        const issues: string[] = [];
        const options = asRecord(input.options);
        const apiKey = readString(options.apiKey);
        const baseUrl =
          readString(options.agentApiBaseUrl) ??
          readString(options.baseUrl) ??
          readString(process.env.OPENAI_BASE_URL);
        if (!apiKey) {
          issues.push("Missing API key (expected env var: OPENAI_API_KEY)");
        }
        if (!baseUrl) {
          issues.push(
            "Missing base URL for API transport (set OPENAI_BASE_URL or profile baseUrl)",
          );
        }
        if (issues.length > 0) {
          return { ok: false, message: issues.join("; ") };
        }
        return validateCodexAgentApiConnection({ ...input, transport });
      }

      return validateCodexCliConnection({ ...input, transport });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      const options = asRecord(input.options);
      const transport = resolveTransport({ transport: input.transport, options });
      if (transport === RuntimeTransport.API) {
        try {
          const models = enrichCodexDiscoveredModels(await listCodexAgentApiModels(input));
          if (models.length > 0) {
            logger.debug?.(
              {
                runtimeId: input.runtimeId,
                profileId: input.profileId ?? null,
                modelCount: models.length,
              },
              "DEBUG [runtime:codex] Fetched model list from OpenAI API",
            );
            return models;
          }
        } catch {
          logger.warn?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
            },
            "WARN [runtime:codex] OpenAI API model discovery failed, falling back to built-in list",
          );
        }
      }

      if (transport === RuntimeTransport.CLI || transport === RuntimeTransport.SDK) {
        const slowPathStartedAt = Date.now();
        logger.debug?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport,
          },
          "DEBUG [runtime:codex] Running app-server model discovery slow path (cache miss at runtime service level)",
        );
        try {
          const models = await listCodexAppServerModels({ ...input, transport }, logger);
          if (models.length > 0) {
            logger.debug?.(
              {
                runtimeId: input.runtimeId,
                profileId: input.profileId ?? null,
                transport,
                discoveryDurationMs: Date.now() - slowPathStartedAt,
              },
              "DEBUG [runtime:codex] Codex app-server model discovery slow path completed",
            );
            return models;
          }
        } catch (error) {
          logger.warn?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              transport,
              discoveryDurationMs: Date.now() - slowPathStartedAt,
              error: error instanceof Error ? error.message : String(error),
            },
            "WARN [runtime:codex] Codex app-server model discovery failed, falling back to built-in list",
          );
        }
      }

      logger.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport,
        },
        "DEBUG [runtime:codex] Returning built-in model list",
      );
      return getDefaultCodexModels();
    },

    initProject(projectRoot) {
      initCodexProject(projectRoot);
    },

    async getMcpStatus(input) {
      return getCodexMcpStatus(input);
    },
    async installMcpServer(input) {
      return installCodexMcpServer(input);
    },
    async uninstallMcpServer(input) {
      return uninstallCodexMcpServer(input);
    },
  };
}
