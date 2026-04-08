import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudePath } from "./findPath.js";
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
} from "../../types.js";
import { diagnoseClaudeError } from "./diagnostics.js";
import { getClaudeMcpStatus, installClaudeMcpServer, uninstallClaudeMcpServer } from "./mcp.js";
import { initClaudeProject } from "./project.js";
import {
  listClaudeRuntimeSessionEvents,
  getClaudeRuntimeSession,
  listClaudeRuntimeSessions,
} from "./sessions.js";
import { buildClaudeQueryOptions, parseExecutionOptions } from "./options.js";
import { runClaudeRuntime, type ClaudeRuntimeRunLogger } from "./run.js";
import { runClaudeCli, probeClaudeCli, type ClaudeCliLogger } from "./cli.js";

export type ClaudeRuntimeAdapterLogger = ClaudeRuntimeRunLogger & ClaudeCliLogger;

export interface CreateClaudeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: ClaudeRuntimeAdapterLogger;
  /** Override for Claude CLI path. If omitted, auto-discovered via findClaudePath(). */
  executablePath?: string;
}

const DEFAULT_CLAUDE_MODELS: RuntimeModel[] = [
  {
    id: "opus",
    label: "Claude Opus",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
    },
  },
  {
    id: "sonnet",
    label: "Claude Sonnet",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      supportsAdaptiveThinking: true,
    },
  },
  {
    id: "haiku",
    label: "Claude Haiku",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
  },
];
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;

function createFallbackLogger(): ClaudeRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime:claude]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:claude]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:claude]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:claude]", message, context);
    },
  };
}

// ---------------------------------------------------------------------------
// Transport-aware capabilities
// ---------------------------------------------------------------------------

/** SDK transport has full capabilities. */
const SDK_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
};

/**
 * CLI transport supports agent definitions (via --agent flag), sessions
 * (via --resume), but no streaming or approvals.
 */
const CLI_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: false,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
};

/** API transport — requires explicit key + baseUrl, no agent definitions. */
const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
};

function readStringOption(input: RuntimeConnectionValidationInput, key: string): string | null {
  const options = input.options ?? {};
  const raw = options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function normalizeSdkExecutablePath(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return path.toLowerCase().endsWith(".cmd") ? undefined : path;
}

function toClaudeModelDiscoveryInput(input: RuntimeModelListInput): RuntimeRunInput {
  const options = { ...(input.options ?? {}) };
  if (input.baseUrl && typeof options.baseUrl !== "string") {
    options.baseUrl = input.baseUrl;
  }
  if (input.apiKey && typeof options.apiKey !== "string") {
    options.apiKey = input.apiKey;
  }
  if (input.apiKeyEnvVar && typeof options.apiKeyEnvVar !== "string") {
    options.apiKeyEnvVar = input.apiKeyEnvVar;
  }
  if (input.headers && options.headers == null) {
    options.headers = input.headers;
  }
  return {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId,
    transport: input.transport,
    prompt: "",
    model: input.model,
    projectRoot: input.projectRoot,
    cwd: input.projectRoot,
    headers: input.headers,
    options,
  };
}

function resolveModelDiscoveryTimeoutMs(input: RuntimeModelListInput): number {
  const rawTimeout = input.options?.modelDiscoveryTimeoutMs;
  if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
    return Math.floor(rawTimeout);
  }
  if (typeof rawTimeout === "string") {
    const parsed = Number.parseInt(rawTimeout, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (error) {
        reject(error);
        return;
      }
      reject(new Error(`Claude model discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    void operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function listClaudeModels(
  input: RuntimeModelListInput,
  logger: ClaudeRuntimeAdapterLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeModel[]> {
  const discoveryInput = toClaudeModelDiscoveryInput(input);
  const configuredCliPath =
    typeof input.options?.claudeCliPath === "string" &&
    input.options.claudeCliPath.trim().length > 0
      ? input.options.claudeCliPath.trim()
      : null;
  const execution = parseExecutionOptions(discoveryInput, {
    pathToClaudeCodeExecutable: normalizeSdkExecutablePath(
      configuredCliPath ?? adapterDefaults?.pathToClaudeCodeExecutable,
    ),
  });
  const modelDiscoveryAbortController = new AbortController();
  const upstreamAbortController = execution.abortController;
  let removeAbortRelay: (() => void) | null = null;
  if (upstreamAbortController) {
    const relayAbort = () => {
      modelDiscoveryAbortController.abort(upstreamAbortController.signal.reason);
    };
    if (upstreamAbortController.signal.aborted) {
      relayAbort();
    } else {
      upstreamAbortController.signal.addEventListener("abort", relayAbort, { once: true });
      removeAbortRelay = () => {
        upstreamAbortController.signal.removeEventListener("abort", relayAbort);
      };
    }
  }
  const queryOptions = buildClaudeQueryOptions(
    discoveryInput,
    {
      ...execution,
      abortController: modelDiscoveryAbortController,
    },
    logger,
  );
  const env = queryOptions.env;
  const envRecord =
    env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
  const configuredApiKeyEnvVar =
    typeof discoveryInput.options?.apiKeyEnvVar === "string"
      ? discoveryInput.options.apiKeyEnvVar
      : null;
  logger.debug?.(
    {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: input.transport ?? RuntimeTransport.SDK,
      apiKeyEnvVar: configuredApiKeyEnvVar,
      hasConfiguredApiKey: configuredApiKeyEnvVar
        ? Boolean(envRecord[configuredApiKeyEnvVar])
        : false,
      hasAnthropicApiKey: Boolean(envRecord.ANTHROPIC_API_KEY),
      hasBaseUrl: typeof envRecord.ANTHROPIC_BASE_URL === "string",
    },
    "DEBUG [runtime:claude] Starting Claude model discovery",
  );
  let session: ReturnType<typeof query> | null = null;
  const discoveryStartedAt = Date.now();
  const timeoutMs = resolveModelDiscoveryTimeoutMs(input);
  let timedOut = false;
  let discoveryError: unknown = null;

  try {
    session = query({
      prompt: (async function* emptyPrompt() {})(),
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });
    const models = await withTimeout(
      () => session!.supportedModels(),
      timeoutMs,
      () => {
        timedOut = true;
        modelDiscoveryAbortController.abort();
      },
    );
    logger.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.SDK,
        modelCount: models.length,
        discoveryDurationMs: Date.now() - discoveryStartedAt,
        timeoutMs,
      },
      "DEBUG [runtime:claude] Claude model discovery finished",
    );
    if (models.length > 0) {
      return models.map((model) => ({
        id: model.value,
        label: model.displayName,
        supportsStreaming: true,
        metadata: {
          description: model.description,
          ...(model.supportsEffort ? { supportsEffort: true } : {}),
          ...(model.supportedEffortLevels
            ? { supportedEffortLevels: [...model.supportedEffortLevels] }
            : {}),
          ...(model.supportsAdaptiveThinking ? { supportsAdaptiveThinking: true } : {}),
          ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
          ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
        },
      }));
    }
  } catch (error) {
    discoveryError = error;
  } finally {
    removeAbortRelay?.();
    try {
      if (timedOut) {
        session?.close?.();
      } else {
        await session?.return?.();
      }
    } catch (cleanupError) {
      logger.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
        "ERROR [runtime:claude] Failed to clean up Claude model discovery session",
      );
    }
  }

  if (discoveryError) {
    const errorMessage =
      discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    if (timedOut) {
      logger.warn?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          timeoutMs,
          discoveryDurationMs: Date.now() - discoveryStartedAt,
          error: errorMessage,
        },
        "WARN [runtime:claude] Claude model discovery timed out, falling back to built-in list",
      );
    } else {
      logger.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          discoveryDurationMs: Date.now() - discoveryStartedAt,
          error: errorMessage,
        },
        "ERROR [runtime:claude] Claude model discovery failed after cleanup, falling back to built-in list",
      );
    }
  }

  return DEFAULT_CLAUDE_MODELS;
}

async function validateClaudeConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const transport = input.transport ?? RuntimeTransport.SDK;
  const apiKey = readStringOption(input, "apiKey");
  const apiKeyEnvVar = readStringOption(input, "apiKeyEnvVar");
  const baseUrl = readStringOption(input, "baseUrl");

  if (transport === RuntimeTransport.SDK) {
    // SDK transport uses ~/.claude/ session auth — API key is optional
    return {
      ok: true,
      message: apiKey
        ? "Claude SDK profile configured with API key"
        : "Claude SDK profile configured (using session auth)",
    };
  }

  if (transport === RuntimeTransport.API) {
    const issues: string[] = [];
    if (!apiKey) {
      issues.push(`Missing API key (expected env var: ${apiKeyEnvVar ?? "ANTHROPIC_API_KEY"})`);
    }
    if (!baseUrl) {
      issues.push("Missing base URL for API transport (set ANTHROPIC_BASE_URL or profile baseUrl)");
    }
    if (issues.length > 0) {
      return { ok: false, message: issues.join("; ") };
    }
    return { ok: true, message: "Claude API profile configured" };
  }

  // CLI transport — probe the binary to verify it's reachable
  const cliPath = readStringOption(input, "claudeCliPath") ?? "claude";
  const probe = probeClaudeCli(cliPath);
  if (!probe.ok) {
    return {
      ok: false,
      message: `Claude CLI is not reachable (${cliPath}): ${probe.error}`,
    };
  }

  return {
    ok: true,
    message: `Claude CLI ${probe.version ?? "unknown"} (${cliPath})`,
  };
}

export function createClaudeRuntimeAdapter(
  options: CreateClaudeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "claude";
  const providerId = options.providerId ?? "anthropic";
  const logger = options.logger ?? createFallbackLogger();
  const executablePath = options.executablePath ?? findClaudePath();

  // On Windows, npm installs produce `.cmd` wrappers (e.g. claude.cmd).
  // The Anthropic SDK spawns `pathToClaudeCodeExecutable` directly without
  // shell, so passing a `.cmd` path causes EINVAL. For SDK transport, omit
  // the path and let the SDK resolve it via its own lookup. CLI transport
  // already uses `shell: true` on Windows so `.cmd` works there.
  const sdkExecutablePath = executablePath?.endsWith(".cmd") ? undefined : executablePath;

  function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transport = input.transport ?? RuntimeTransport.SDK;
    if (transport === RuntimeTransport.CLI) {
      return runClaudeCli(input, logger, { pathToClaudeCodeExecutable: executablePath });
    }
    // SDK and API both go through the Agent SDK runtime
    return runClaudeRuntime(input, logger, { pathToClaudeCodeExecutable: sdkExecutablePath });
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Claude",
      supportsProjectInit: true,
      lightModel: "haiku",
      defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
      defaultBaseUrlEnvVar: "ANTHROPIC_BASE_URL",
      defaultModelPlaceholder: "opus",
      defaultTransport: RuntimeTransport.SDK,
      supportedTransports: [RuntimeTransport.SDK, RuntimeTransport.CLI, RuntimeTransport.API],
      capabilities: SDK_CAPABILITIES,
    },
    getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
      switch (transport) {
        case RuntimeTransport.CLI:
          return CLI_CAPABILITIES;
        case RuntimeTransport.API:
          return API_CAPABILITIES;
        default:
          return SDK_CAPABILITIES;
      }
    },
    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      return runByTransport(input);
    },
    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      return runByTransport({ ...input, resume: true });
    },
    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listClaudeRuntimeSessions(input);
    },
    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getClaudeRuntimeSession(input);
    },
    async listSessionEvents(input: RuntimeSessionEventsInput) {
      return listClaudeRuntimeSessionEvents(input);
    },
    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      return validateClaudeConnection(input);
    },
    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      return listClaudeModels(input, logger, {
        pathToClaudeCodeExecutable: sdkExecutablePath,
      });
    },
    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseClaudeError(input, executablePath);
    },
    sanitizeInput(text: string): string {
      return text
        .replace(/<command-name>[^<]*<\/command-name>/g, "")
        .replace(/<command-message>[^<]*<\/command-message>/g, "")
        .replace(/<command-args>([^<]*)<\/command-args>/g, "$1")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
        .trim();
    },
    initProject(projectRoot) {
      initClaudeProject(projectRoot);
    },
    async getMcpStatus(input) {
      return getClaudeMcpStatus(input);
    },
    async installMcpServer(input) {
      return installClaudeMcpServer(input);
    },
    async uninstallMcpServer(input) {
      return uninstallClaudeMcpServer(input);
    },
  };
}
