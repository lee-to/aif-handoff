import { RuntimeExecutionError, type RuntimeErrorCategory } from "../../errors.js";

const USAGE_LIMIT_PATTERNS = ["usage limit", "out of extra usage", "rate limit", "quota"];
const PERMISSION_PATTERNS = ["permission denied", "write permission", "blocked by permissions"];

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(message: string): { adapterCode: string; category: RuntimeErrorCategory } {
  const lowered = message.toLowerCase();

  if (USAGE_LIMIT_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CLAUDE_USAGE_LIMIT", category: "rate_limit" };
  }
  if (PERMISSION_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CLAUDE_PERMISSION_DENIED", category: "permission" };
  }
  if (lowered.includes("query_start_timeout")) {
    return { adapterCode: "CLAUDE_QUERY_START_TIMEOUT", category: "timeout" };
  }
  if (
    lowered.includes("stream_error") ||
    lowered.includes("stream closed") ||
    lowered.includes("stream interrupted")
  ) {
    return { adapterCode: "CLAUDE_STREAM_ERROR", category: "stream" };
  }

  return { adapterCode: "CLAUDE_RUNTIME_ERROR", category: "unknown" };
}

export class ClaudeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause, category);
    this.name = "ClaudeRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyClaudeRuntimeError(error: unknown): ClaudeRuntimeAdapterError {
  const message = messageFromUnknown(error);
  const { adapterCode, category } = classify(message);
  return new ClaudeRuntimeAdapterError(message, adapterCode, category, error);
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
