import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** Codex-specific CLI patterns that don't map to shared categories. */
const CLI_NOT_FOUND_PATTERNS = ["enoent", "not recognized", "no such file"];
const THREAD_PATTERNS = [
  "thread not found",
  "session not found",
  "no such session",
  "invalid thread",
];

/** Map semantic category to Codex-specific adapter code. */
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "CODEX_RATE_LIMIT",
  auth: "CODEX_AUTH_ERROR",
  timeout: "CODEX_TIMEOUT",
  permission: "CODEX_PERMISSION_DENIED",
  stream: "CODEX_STREAM_ERROR",
  transport: "CODEX_TRANSPORT_ERROR",
  model_not_found: "CODEX_MODEL_NOT_FOUND",
  context_length: "CODEX_CONTEXT_LENGTH",
  content_filter: "CODEX_CONTENT_FILTER",
  unknown: "CODEX_RUNTIME_ERROR",
};

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Primary: HTTP status (API transport)
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
  }

  const lowered = message.toLowerCase();

  // Codex-specific: thread/session not found (check before CLI patterns)
  if (THREAD_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_THREAD_NOT_FOUND", category: "unknown" };
  }

  // Codex-specific: CLI not found (no shared equivalent)
  if (CLI_NOT_FOUND_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_CLI_NOT_FOUND", category: "unknown" };
  }

  // Fallback: shared message-based classification
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

export class CodexRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    super(message, cause, category, { ...metadata, adapterCode });
    this.name = "CodexRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyCodexRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): CodexRuntimeAdapterError {
  if (error instanceof CodexRuntimeAdapterError) {
    return error;
  }
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  if (error instanceof RuntimeExecutionError) {
    return new CodexRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new CodexRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}
