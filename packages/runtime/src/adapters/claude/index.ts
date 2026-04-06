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
import { runClaudeRuntime, type ClaudeRuntimeRunLogger } from "./run.js";
import { runClaudeCli, type ClaudeCliLogger } from "./cli.js";

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
  { id: "sonnet", label: "Claude Sonnet", supportsStreaming: true },
  { id: "opus", label: "Claude Opus", supportsStreaming: true },
  { id: "haiku", label: "Claude Haiku", supportsStreaming: true },
];

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

  // CLI transport — no key needed
  return {
    ok: true,
    message: "Claude CLI profile configured",
  };
}

async function listClaudeModels(_input: RuntimeModelListInput): Promise<RuntimeModel[]> {
  return DEFAULT_CLAUDE_MODELS;
}

export function createClaudeRuntimeAdapter(
  options: CreateClaudeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "claude";
  const providerId = options.providerId ?? "anthropic";
  const logger = options.logger ?? createFallbackLogger();
  const executablePath = options.executablePath ?? findClaudePath();

  function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transport = input.transport ?? RuntimeTransport.SDK;
    if (transport === RuntimeTransport.CLI) {
      return runClaudeCli(input, logger, { pathToClaudeCodeExecutable: executablePath });
    }
    // SDK and API both go through the Agent SDK runtime
    return runClaudeRuntime(input, logger, { pathToClaudeCodeExecutable: executablePath });
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Claude",
      lightModel: "haiku",
      defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
      defaultModelPlaceholder: "sonnet",
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
      return listClaudeModels(input);
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
