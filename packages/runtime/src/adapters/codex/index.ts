import { existsSync } from "node:fs";
import { getCodexMcpStatus, installCodexMcpServer, uninstallCodexMcpServer } from "./mcp.js";
import { initCodexProject } from "./project.js";
import {
  RuntimeTransport,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSessionForkInput,
  type RuntimeSessionListInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionEventsInput,
  type RuntimeSession,
  type RuntimeEvent,
} from "../../types.js";
import { RuntimeCapabilityError, RuntimeExecutionError } from "../../errors.js";
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
import { runCodexAppServer } from "./appServer/run.js";
import {
  getCodexAppServerSession,
  listCodexAppServerSessionEvents,
  listCodexAppServerSessions,
} from "./appServer/sessions.js";
import { spawnCodexAppServerProcess, terminateCodexAppServerProcess } from "./appServer/process.js";
import { JsonlRpcClient } from "./appServer/jsonlRpcClient.js";
import { CodexAppServerClient } from "./appServer/client.js";
import { classifyCodexAppServerError } from "./appServer/errors.js";
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
      console.debug("[runtime:codex]", message, context);
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

function sessionIdSuffix(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

type TransportResolutionSource = "input.transport" | "options.transport" | "default";

interface TransportResolution {
  transport: RuntimeTransport;
  requested: string | null;
  source: TransportResolutionSource;
  normalizedFromLegacy: boolean;
  fellBackToDefault: boolean;
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
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  // CLI stream emits token_count events when the turn completes, but some
  // early-termination paths (timeout, non-zero exit) may return before the
  // event is seen — declare PARTIAL so the wrapper tolerates null usage.
  usageReporting: UsageReporting.PARTIAL,
};

const SDK_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  usageReporting: UsageReporting.FULL,
};

const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  usageReporting: UsageReporting.FULL,
};

const APP_SERVER_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: true,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  usageReporting: UsageReporting.PARTIAL,
};

function resolveTransport(input: {
  transport?: string;
  options?: Record<string, unknown>;
}): TransportResolution {
  const requestedFromInput = readString(input.transport);
  const requestedFromOptions = readString(asRecord(input.options).transport);
  const requested = requestedFromInput ?? requestedFromOptions;
  const source: TransportResolutionSource = requestedFromInput
    ? "input.transport"
    : requestedFromOptions
      ? "options.transport"
      : "default";

  if (!requested) {
    return {
      transport: RuntimeTransport.CLI,
      requested: null,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.SDK) {
    return {
      transport: RuntimeTransport.SDK,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.API) {
    return {
      transport: RuntimeTransport.API,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.APP_SERVER) {
    return {
      transport: RuntimeTransport.APP_SERVER,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === "agentapi") {
    return {
      transport: RuntimeTransport.API,
      requested,
      source,
      normalizedFromLegacy: true,
      fellBackToDefault: false,
    };
  }
  return {
    transport: RuntimeTransport.CLI,
    requested,
    source,
    normalizedFromLegacy: false,
    fellBackToDefault: true,
  };
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

function buildValidationLaunchInput(input: RuntimeConnectionValidationInput): {
  runtimeId: string;
  profileId: string | null;
  transport: RuntimeTransport;
  options: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
} {
  const options = asRecord(input.options);
  return {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    options,
    apiKey: readString(options.apiKey),
    apiKeyEnvVar: readString(options.apiKeyEnvVar),
    baseUrl: readString(options.baseUrl),
  };
}

async function validateCodexAppServerConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const cliValidation = await validateCodexCliConnection(input);
  if (!cliValidation.ok) {
    return cliValidation;
  }

  const launch = spawnCodexAppServerProcess({
    input: buildValidationLaunchInput(input),
  });
  const rpcClient = new JsonlRpcClient(launch.process, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: 5_000,
  });
  const appServerClient = new CodexAppServerClient(rpcClient, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: 5_000,
  });

  try {
    await appServerClient.initialize({
      clientInfo: {
        name: "aif-runtime-codex-validation",
        title: "AIF Runtime Codex Validation",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: asRecord(input.options).experimentalApi === true,
      },
    });
    return {
      ok: true,
      message: `Codex app-server initialize handshake succeeded (${launch.executablePath})`,
    };
  } catch (error) {
    const classified = classifyCodexAppServerError(error);
    const installHint = `Install/update Codex CLI and run 'codex auth login' if needed`;
    return {
      ok: false,
      message: `Codex app-server initialize handshake failed: ${classified.message}. ${installHint}.`,
      details: {
        category: classified.category,
        adapterCode: classified.adapterCode ?? null,
      },
    };
  } finally {
    appServerClient.close("validation finished");
    await terminateCodexAppServerProcess(launch);
  }
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
    const transportResolution = resolveTransport({
      transport: input.transport,
      options: input.options,
    });
    const transport = transportResolution.transport;
    const wantsStreaming = input.execution?.onEvent != null;
    if (
      transportResolution.requested === RuntimeTransport.APP_SERVER &&
      transportResolution.source !== "default"
    ) {
      logger.debug?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "DEBUG [runtime:codex] Explicit app-server transport resolved",
      );
    }
    if (transportResolution.normalizedFromLegacy) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "WARN [runtime:codex] Legacy transport alias normalized to api",
      );
    }
    if (transportResolution.fellBackToDefault) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "WARN [runtime:codex] Unknown transport requested, defaulting to cli",
      );
    }
    logger.info?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
        requestedTransport: transportResolution.requested,
        transportSource: transportResolution.source,
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

    if (transport === RuntimeTransport.APP_SERVER) {
      return runCodexAppServer({ ...input, transport }, logger);
    }

    return runCodexCli({ ...input, transport }, logger);
  }

  async function forkByTransport(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
    const transportResolution = resolveTransport({
      transport: input.transport,
      options: input.options,
    });
    const transport = transportResolution.transport;

    if (transport !== RuntimeTransport.APP_SERVER) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          requestedTransport: transportResolution.requested,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          skipReason: "unsupported_transport",
        },
        "WARN [runtime:codex] Session fork requested for unsupported transport",
      );
      throw new RuntimeCapabilityError(
        `Codex ${transport} transport does not support session fork`,
      );
    }

    logger.debug?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
        sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
      },
      "DEBUG [runtime:codex] Starting Codex session fork run",
    );

    try {
      const result = await runCodexAppServer({ ...input, transport }, logger);
      logger.debug?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          childSessionIdSuffix: sessionIdSuffix(result.sessionId ?? result.session?.id ?? null),
        },
        "DEBUG [runtime:codex] Codex session fork run completed",
      );
      return result;
    } catch (error) {
      const classified =
        error instanceof RuntimeExecutionError ? error : classifyCodexRuntimeError(error);
      logger.error?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          category: classified.category,
          adapterCode: classified.adapterCode ?? null,
          error: classified.message,
        },
        "ERROR [runtime:codex] Codex session fork run failed",
      );
      throw classified;
    }
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Codex",
      supportsProjectInit: true,
      projectInitAgentName: "codex",
      skillCommandPrefix: "$",
      lightModel: null,
      defaultApiKeyEnvVar: "OPENAI_API_KEY",
      defaultBaseUrlEnvVar: "OPENAI_BASE_URL",
      defaultModelPlaceholder: "gpt-5.4",
      supportedTransports: [
        RuntimeTransport.SDK,
        RuntimeTransport.CLI,
        RuntimeTransport.APP_SERVER,
        RuntimeTransport.API,
      ],
      defaultTransport: RuntimeTransport.CLI,
      capabilities: CLI_CAPABILITIES,
    },

    getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
      switch (transport) {
        case RuntimeTransport.SDK:
          return SDK_CAPABILITIES;
        case RuntimeTransport.APP_SERVER:
          return APP_SERVER_CAPABILITIES;
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

    async forkSession(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
      return await forkByTransport(input);
    },

    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return listCodexAppServerSessions(input, logger);
      }
      return listCodexSdkSessions(input);
    },

    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return getCodexAppServerSession(input, logger);
      }
      return getCodexSdkSession(input);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return listCodexAppServerSessionEvents(input, logger);
      }
      return listCodexSdkSessionEvents(input);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const rawTransport = readString(input.transport);
      if (
        rawTransport &&
        rawTransport !== RuntimeTransport.CLI &&
        rawTransport !== RuntimeTransport.APP_SERVER &&
        rawTransport !== RuntimeTransport.API &&
        rawTransport !== RuntimeTransport.SDK &&
        rawTransport !== "agentapi"
      ) {
        return {
          ok: false,
          message: `Codex does not support "${rawTransport}" transport. Use "sdk", "cli", "app-server", or "api".`,
        };
      }

      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;

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

      if (transport === RuntimeTransport.APP_SERVER) {
        return validateCodexAppServerConnection({ ...input, transport });
      }

      return validateCodexCliConnection({ ...input, transport });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      const options = asRecord(input.options);
      const transport = resolveTransport({ transport: input.transport, options }).transport;
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
              "[runtime:codex] Fetched model list from OpenAI API",
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

      if (
        transport === RuntimeTransport.CLI ||
        transport === RuntimeTransport.SDK ||
        transport === RuntimeTransport.APP_SERVER
      ) {
        const slowPathStartedAt = Date.now();
        logger.debug?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport,
          },
          "[runtime:codex] Running app-server model discovery slow path (cache miss at runtime service level)",
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
              "[runtime:codex] Codex app-server model discovery slow path completed",
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
        "[runtime:codex] Returning built-in model list",
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
