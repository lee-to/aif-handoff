import { RuntimeExecutionError } from "../../errors.js";

const CLI_NOT_FOUND_PATTERNS = ["enoent", "not recognized", "not found", "no such file"];
const TIMEOUT_PATTERNS = ["timed out", "timeout", "etimedout"];
const AUTH_PATTERNS = ["unauthorized", "invalid api key", "forbidden", "401", "403"];
const TRANSPORT_PATTERNS = ["connection refused", "econnrefused", "network", "fetch failed"];

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyCode(message: string): string {
  const lowered = message.toLowerCase();
  if (CLI_NOT_FOUND_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CODEX_CLI_NOT_FOUND";
  }
  if (TIMEOUT_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CODEX_TIMEOUT";
  }
  if (AUTH_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CODEX_AUTH_ERROR";
  }
  if (TRANSPORT_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CODEX_TRANSPORT_ERROR";
  }
  return "CODEX_RUNTIME_ERROR";
}

export class CodexRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(message: string, adapterCode: string, cause?: unknown) {
    super(message, cause);
    this.name = "CodexRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyCodexRuntimeError(error: unknown): CodexRuntimeAdapterError {
  const message = messageFromUnknown(error);
  const adapterCode = classifyCode(message);
  return new CodexRuntimeAdapterError(message, adapterCode, error);
}
