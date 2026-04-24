import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** Map semantic category to Claude-specific adapter code. */
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "CLAUDE_USAGE_LIMIT",
  auth: "CLAUDE_AUTH_ERROR",
  timeout: "CLAUDE_QUERY_START_TIMEOUT",
  permission: "CLAUDE_PERMISSION_DENIED",
  stream: "CLAUDE_STREAM_ERROR",
  transport: "CLAUDE_TRANSPORT_ERROR",
  model_not_found: "CLAUDE_MODEL_NOT_FOUND",
  context_length: "CLAUDE_CONTEXT_LENGTH",
  content_filter: "CLAUDE_CONTENT_FILTER",
  unknown: "CLAUDE_RUNTIME_ERROR",
};

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Primary: HTTP status (API transports)
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
  }

  // Fallback: shared message-based classification (CLI/SDK transports)
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

function mergeMetadata(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): RuntimeExecutionErrorMetadata {
  const baseMetadata: RuntimeExecutionErrorMetadata =
    error instanceof RuntimeExecutionError
      ? {
          httpStatus: error.httpStatus,
          resetAt: error.resetAt,
          retryAfterMs: error.retryAfterMs,
          retryAfterSeconds: error.retryAfterSeconds,
          limitSnapshot: error.limitSnapshot,
          providerMeta: error.providerMeta,
        }
      : {};

  return {
    ...baseMetadata,
    ...metadata,
    httpStatus: httpStatus ?? metadata.httpStatus ?? baseMetadata.httpStatus,
  };
}

export class ClaudeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    super(message, cause, category, { ...metadata, adapterCode });
    this.name = "ClaudeRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyClaudeRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): ClaudeRuntimeAdapterError {
  if (error instanceof ClaudeRuntimeAdapterError) {
    return error;
  }
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  if (error instanceof RuntimeExecutionError) {
    return new ClaudeRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new ClaudeRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
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
  metadata: RuntimeExecutionErrorMetadata = {},
): ClaudeRuntimeAdapterError {
  const normalizedDetail = normalizeDetail(detail);
  const base = `Claude query failed: ${subtype}`;
  const message = normalizedDetail ? `${base}: ${normalizedDetail}` : base;
  return classifyClaudeRuntimeError(message, metadata.httpStatus, metadata);
}
