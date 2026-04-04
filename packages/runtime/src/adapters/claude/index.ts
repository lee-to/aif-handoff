import type {
  RuntimeAdapter,
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import {
  listClaudeRuntimeSessionEvents,
  getClaudeRuntimeSession,
  listClaudeRuntimeSessions,
} from "./sessions.js";
import { runClaudeRuntime, type ClaudeRuntimeRunLogger } from "./run.js";

export type ClaudeRuntimeAdapterLogger = ClaudeRuntimeRunLogger;

export interface CreateClaudeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: ClaudeRuntimeAdapterLogger;
}

const DEFAULT_CLAUDE_MODELS: RuntimeModel[] = [
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", supportsStreaming: true },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1", supportsStreaming: true },
  { id: "claude-haiku-3-5", label: "Claude Haiku 3.5", supportsStreaming: true },
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

function readStringOption(input: RuntimeConnectionValidationInput, key: string): string | null {
  const options = input.options ?? {};
  const raw = options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

async function validateClaudeConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const transport = input.transport ?? "sdk";
  const apiKey = readStringOption(input, "apiKey");
  const apiKeyEnvVar = readStringOption(input, "apiKeyEnvVar");

  if (transport !== "cli" && !apiKey) {
    return {
      ok: false,
      message: "Missing API key for Claude runtime profile",
      details: {
        expectedEnvVar: apiKeyEnvVar ?? "ANTHROPIC_API_KEY",
      },
    };
  }

  return {
    ok: true,
    message: "Claude runtime profile configuration looks valid",
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

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Claude",
      capabilities: {
        supportsResume: true,
        supportsSessionList: true,
        supportsAgentDefinitions: true,
        supportsStreaming: true,
        supportsModelDiscovery: true,
        supportsApprovals: true,
        supportsCustomEndpoint: true,
      },
    },
    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      return runClaudeRuntime(input, logger);
    },
    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      return runClaudeRuntime({ ...input, resume: true }, logger);
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
  };
}
