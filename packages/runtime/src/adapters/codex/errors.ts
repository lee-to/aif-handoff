import { RuntimeExecutionError, type RuntimeErrorCategory } from "../../errors.js";

const CLI_NOT_FOUND_PATTERNS = ["enoent", "not recognized", "not found", "no such file"];
const TIMEOUT_PATTERNS = ["timed out", "timeout", "etimedout"];
const AUTH_PATTERNS = ["unauthorized", "invalid api key", "forbidden", "401", "403"];
const TRANSPORT_PATTERNS = ["connection refused", "econnrefused", "network", "fetch failed"];
const THREAD_PATTERNS = [
  "thread not found",
  "session not found",
  "no such session",
  "invalid thread",
];
const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "429",
  "insufficient_quota",
  "quota",
];

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(message: string): { adapterCode: string; category: RuntimeErrorCategory } {
  const lowered = message.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_RATE_LIMIT", category: "rate_limit" };
  }
  if (CLI_NOT_FOUND_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_CLI_NOT_FOUND", category: "unknown" };
  }
  if (TIMEOUT_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_TIMEOUT", category: "timeout" };
  }
  if (AUTH_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_AUTH_ERROR", category: "auth" };
  }
  if (TRANSPORT_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_TRANSPORT_ERROR", category: "unknown" };
  }
  if (THREAD_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_THREAD_NOT_FOUND", category: "unknown" };
  }
  return { adapterCode: "CODEX_RUNTIME_ERROR", category: "unknown" };
}

export class CodexRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause, category);
    this.name = "CodexRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyCodexRuntimeError(error: unknown): CodexRuntimeAdapterError {
  const message = messageFromUnknown(error);
  const { adapterCode, category } = classify(message);
  return new CodexRuntimeAdapterError(message, adapterCode, category, error);
}
