import { RuntimeExecutionError } from "../../errors.js";

const USAGE_LIMIT_PATTERNS = ["usage limit", "out of extra usage", "rate limit", "quota"];
const PERMISSION_PATTERNS = ["permission denied", "write permission", "blocked by permissions"];

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyCode(message: string): string {
  const lowered = message.toLowerCase();

  if (USAGE_LIMIT_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CLAUDE_USAGE_LIMIT";
  }
  if (PERMISSION_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return "CLAUDE_PERMISSION_DENIED";
  }
  if (lowered.includes("query_start_timeout")) {
    return "CLAUDE_QUERY_START_TIMEOUT";
  }
  if (lowered.includes("stream")) {
    return "CLAUDE_STREAM_ERROR";
  }

  return "CLAUDE_RUNTIME_ERROR";
}

export class ClaudeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(message: string, adapterCode: string, cause?: unknown) {
    super(message, cause);
    this.name = "ClaudeRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyClaudeRuntimeError(error: unknown): ClaudeRuntimeAdapterError {
  const message = messageFromUnknown(error);
  const adapterCode = classifyCode(message);
  return new ClaudeRuntimeAdapterError(message, adapterCode, error);
}

function normalizeDetail(detail: string | null | undefined): string | null {
  if (typeof detail !== "string") return null;
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

export function classifyClaudeResultSubtype(
  subtype: string,
  detail?: string | null,
): ClaudeRuntimeAdapterError {
  const normalizedDetail = normalizeDetail(detail);
  const base = `Claude query failed: ${subtype}`;
  const message = normalizedDetail ? `${base}: ${normalizedDetail}` : base;
  return classifyClaudeRuntimeError(message);
}
