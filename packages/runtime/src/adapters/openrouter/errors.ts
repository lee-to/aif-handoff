import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** Map semantic category to OpenRouter-specific adapter code. */
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "OPENROUTER_RATE_LIMIT",
  auth: "OPENROUTER_AUTH_ERROR",
  timeout: "OPENROUTER_TIMEOUT",
  permission: "OPENROUTER_PERMISSION_DENIED",
  stream: "OPENROUTER_STREAM_ERROR",
  transport: "OPENROUTER_TRANSPORT_ERROR",
  model_not_found: "OPENROUTER_MODEL_NOT_FOUND",
  context_length: "OPENROUTER_CONTEXT_LENGTH",
  content_filter: "OPENROUTER_CONTENT_FILTER",
  unknown: "OPENROUTER_RUNTIME_ERROR",
};

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Primary: HTTP status (API transport — this is OpenRouter's only transport)
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
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

export class OpenRouterRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    super(message, cause, category, { ...metadata, adapterCode });
    this.name = "OpenRouterRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyOpenRouterRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): OpenRouterRuntimeAdapterError {
  if (error instanceof OpenRouterRuntimeAdapterError) {
    return error;
  }
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  if (error instanceof RuntimeExecutionError) {
    return new OpenRouterRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new OpenRouterRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}
