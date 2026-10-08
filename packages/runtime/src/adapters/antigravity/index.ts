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
import { findAntigravityPath, probeAntigravityCli, resolveCliPath } from "./findPath.js";
import { runAntigravityCli, type AntigravityCliLogger } from "./cli.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL,
  LIGHT_ANTIGRAVITY_MODEL,
  discoverAntigravityModels,
} from "./models.js";
import { getEnv } from "@aif/shared";
import { classifyAntigravityRuntimeError } from "./errors.js";

export type AntigravityRuntimeAdapterLogger = AntigravityCliLogger;

export interface CreateAntigravityRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: AntigravityRuntimeAdapterLogger;
  executablePath?: string;
  supportsProjectInit?: boolean;
}

const ANTIGRAVITY_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  usageReporting: UsageReporting.FULL,
  supportsInteractiveQuestions: false,
};

function createFallbackLogger(): AntigravityRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:antigravity]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:antigravity]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:antigravity]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:antigravity]", message, context);
    },
  };
}

export function createAntigravityRuntimeAdapter(
  options: CreateAntigravityRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "antigravity";
  const providerId = options.providerId ?? "google";
  const logger = options.logger ?? createFallbackLogger();
  const executablePath = options.executablePath ?? findAntigravityPath();

  const supportsProjectInit =
    options.supportsProjectInit ?? getEnv().AIF_RUNTIME_ANTIGRAVITY_ENABLED;

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Google Antigravity",
      supportsProjectInit,
      projectInitAgentName: supportsProjectInit ? "antigravity" : undefined,
      lightModel: LIGHT_ANTIGRAVITY_MODEL,
      defaultModelPlaceholder: DEFAULT_ANTIGRAVITY_MODEL,
      defaultTransport: RuntimeTransport.CLI,
      supportedTransports: [RuntimeTransport.CLI],
      capabilities: ANTIGRAVITY_CAPABILITIES,
    },

    getEffectiveCapabilities(_transport?: RuntimeTransport): RuntimeCapabilities {
      return ANTIGRAVITY_CAPABILITIES;
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      return runAntigravityCli(input, logger, {
        pathToAntigravityExecutable: resolveCliPath(input.options, executablePath),
      });
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      return runAntigravityCli(input, logger, {
        pathToAntigravityExecutable: resolveCliPath(input.options, executablePath),
      });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      return discoverAntigravityModels({ cliPath: resolveCliPath(input.options, executablePath) });
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const cliPath = resolveCliPath(input.options, executablePath);

      const probe = probeAntigravityCli(cliPath);
      if (!probe.ok) {
        return {
          ok: false,
          message: `Antigravity CLI is not reachable (${cliPath}): ${probe.error}`,
        };
      }

      return {
        ok: true,
        message: `Google Antigravity CLI ${probe.version ?? "unknown"} (${cliPath})`,
      };
    },

    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
      const tail = input.stderrTail ? `\nStderr tail:\n${input.stderrTail}` : "";
      const lowered = `${errorMsg} ${input.stderrTail ?? ""}`.toLowerCase();
      const classified = classifyAntigravityRuntimeError(input.error);

      let suggestion = "";
      if (
        classified.category === "model_not_found" ||
        classified.adapterCode === "ANTIGRAVITY_MODEL_NOT_FOUND" ||
        lowered.includes("invalid model selection") ||
        (lowered.includes("model") &&
          (lowered.includes("not recognized") || lowered.includes("not found")))
      ) {
        suggestion =
          "\nRecommendation: Selected model is not recognized by Antigravity CLI. Use a supported model such as 'gemini-3.8-flash-high'.";
      } else if (
        classified.category === "auth" ||
        classified.adapterCode === "ANTIGRAVITY_AUTH_ERROR" ||
        lowered.includes("auth") ||
        lowered.includes("not logged in")
      ) {
        suggestion = "\nRecommendation: Run 'agy' or login interactively to refresh credentials.";
      } else if (
        classified.category === "rate_limit" ||
        classified.adapterCode === "ANTIGRAVITY_CAPACITY_UNAVAILABLE" ||
        lowered.includes("503") ||
        lowered.includes("capacity")
      ) {
        suggestion =
          "\nRecommendation: Gemini model capacity is temporarily exhausted. Switch to 'gemini-3.8-flash-low' or retry in a few moments.";
      } else if (
        classified.adapterCode === "ANTIGRAVITY_CLI_NOT_FOUND" ||
        (input.error as { code?: string })?.code === "ENOENT" ||
        lowered.includes("enoent") ||
        lowered.includes("cannot find")
      ) {
        suggestion =
          "\nRecommendation: Ensure 'agy.exe' is installed in PATH or set the ANTIGRAVITY_BIN_PATH environment variable.";
      }

      return `Antigravity execution error: ${errorMsg}${tail}${suggestion}`;
    },

    sanitizeInput(text: string): string {
      return text
        .replace(/<command-name>[^<]*<\/command-name>/g, "")
        .replace(/<command-message>[^<]*<\/command-message>/g, "")
        .replace(/<command-args>([^<]*)<\/command-args>/g, "$1")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .trim();
    },
  };
}

/**
 * External module registration entry point for AIF_RUNTIME_MODULES.
 */
export function registerRuntimeModule(registry: {
  registerRuntime: (adapter: RuntimeAdapter, options?: { source: string }) => void;
}): void {
  registry.registerRuntime(createAntigravityRuntimeAdapter(), { source: "module" });
}
