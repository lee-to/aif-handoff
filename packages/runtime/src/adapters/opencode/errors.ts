import {
  RuntimeExecutionError,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** OpenCode-specific session patterns that don't map to shared categories. */
const SESSION_PATTERNS = ["session", "not found"];

/** Map semantic category to OpenCode-specific adapter code. */
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "OPENCODE_RATE_LIMIT",
  auth: "OPENCODE_AUTH_ERROR",
  timeout: "OPENCODE_TIMEOUT",
  permission: "OPENCODE_PERMISSION_DENIED",
  stream: "OPENCODE_STREAM_ERROR",
  transport: "OPENCODE_TRANSPORT_ERROR",
  model_not_found: "OPENCODE_MODEL_ERROR",
  context_length: "OPENCODE_CONTEXT_LENGTH",
  content_filter: "OPENCODE_CONTENT_FILTER",
  unknown: "OPENCODE_RUNTIME_ERROR",
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

  // OpenCode-specific: session not found
  if (SESSION_PATTERNS.every((pattern) => lowered.includes(pattern))) {
    return { adapterCode: "OPENCODE_SESSION_ERROR", category: "unknown" };
  }

  // Fallback: shared message-based classification
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

export class OpenCodeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause, category);
    this.name = "OpenCodeRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

export function classifyOpenCodeRuntimeError(
  error: unknown,
  httpStatus?: number,
): OpenCodeRuntimeAdapterError {
  if (error instanceof OpenCodeRuntimeAdapterError) {
    return error;
  }
  const message = messageFromUnknown(error);
  const { adapterCode, category } = classify(message, httpStatus);
  return new OpenCodeRuntimeAdapterError(message, adapterCode, category, error);
}
