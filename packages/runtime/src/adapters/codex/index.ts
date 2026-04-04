import { existsSync } from "node:fs";
import type {
  RuntimeAdapter,
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
} from "../../types.js";
import { runCodexCli, type CodexCliLogger } from "./cli.js";
import {
  runCodexAgentApi,
  validateCodexAgentApiConnection,
  type CodexAgentApiLogger,
} from "./agentapi.js";
import { classifyCodexRuntimeError } from "./errors.js";

export type CodexRuntimeAdapterLogger = CodexCliLogger & CodexAgentApiLogger;

export interface CreateCodexRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: CodexRuntimeAdapterLogger;
}

const DEFAULT_CODEX_MODELS: RuntimeModel[] = [
  { id: "gpt-5.4", label: "GPT-5.4", supportsStreaming: true },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", supportsStreaming: true },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsStreaming: true },
];

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

function resolveTransport(input: {
  transport?: string;
  options?: Record<string, unknown>;
}): "cli" | "agentapi" {
  const requested = readString(input.transport) ?? readString(asRecord(input.options).transport);
  return requested === "agentapi" ? "agentapi" : "cli";
}

function resolveCliPath(input: RuntimeConnectionValidationInput): string | null {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

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

  // If an absolute/relative path is passed, verify that file exists.
  const looksLikePath = cliPath.includes("/") || cliPath.includes("\\");
  if (looksLikePath && !existsSync(cliPath)) {
    return {
      ok: false,
      message: `Configured Codex CLI path does not exist: ${cliPath}`,
    };
  }

  return {
    ok: true,
    message: `Codex CLI is configured (${cliPath})`,
  };
}

export function createCodexRuntimeAdapter(
  options: CreateCodexRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "codex";
  const providerId = options.providerId ?? "openai";
  const logger = options.logger ?? createFallbackLogger();

  async function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transport = resolveTransport({ transport: input.transport, options: input.options });
    logger.info?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
      },
      "INFO [runtime:codex] Selected transport",
    );

    if (transport === "agentapi") {
      return runCodexAgentApi({ ...input, transport }, logger);
    }

    return runCodexCli({ ...input, transport }, logger);
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Codex",
      defaultTransport: "cli",
      capabilities: {
        supportsResume: true,
        supportsSessionList: false,
        supportsAgentDefinitions: false,
        supportsStreaming: true,
        supportsModelDiscovery: true,
        supportsApprovals: false,
        supportsCustomEndpoint: true,
      },
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
    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const transport = resolveTransport({ transport: input.transport, options: input.options });
      if (transport === "agentapi") {
        return validateCodexAgentApiConnection({ ...input, transport });
      }
      return validateCodexCliConnection({ ...input, transport });
    },
    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      logger.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          projectRoot: input.projectRoot ?? null,
        },
        "DEBUG [runtime:codex] Returning built-in model list",
      );
      return DEFAULT_CODEX_MODELS;
    },
  };
}
