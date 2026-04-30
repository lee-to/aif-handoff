import {
  classifyByHttpStatus,
  type RuntimeErrorCategory,
  type RuntimeExecutionErrorMetadata,
} from "../../../errors.js";
import { CodexRuntimeAdapterError, classifyCodexRuntimeError } from "../errors.js";
import { JsonlRpcResponseError } from "./jsonlRpcClient.js";

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

const RUNTIME_ERROR_CATEGORIES = new Set<RuntimeErrorCategory>([
  "rate_limit",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
  "model_not_found",
  "context_length",
  "content_filter",
  "unknown",
]);

const STRUCTURED_CODE_TO_CATEGORY: Record<string, RuntimeErrorCategory> = {
  AUTH: "auth",
  UNAUTHORIZED: "auth",
  USAGE_LIMIT_EXCEEDED: "rate_limit",
  SERVER_OVERLOADED: "rate_limit",
  PERMISSION_DENIED: "permission",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  MODEL_NOT_FOUND: "model_not_found",
  CONTEXT_LENGTH_EXCEEDED: "context_length",
  CONTEXT_WINDOW_EXCEEDED: "context_length",
  CONTENT_FILTER: "content_filter",
  TRANSPORT_ERROR: "transport",
  STREAM_ERROR: "stream",
  HTTP_CONNECTION_FAILED: "transport",
  RESPONSE_STREAM_CONNECTION_FAILED: "stream",
  RESPONSE_STREAM_DISCONNECTED: "stream",
  BAD_REQUEST: "transport",
  INTERNAL_SERVER_ERROR: "transport",
  SANDBOX_ERROR: "permission",
};

interface CodexAppServerErrorInfo {
  category: RuntimeErrorCategory | null;
  adapterCode: string | null;
  structuredCode: string | null;
  httpStatusCode: number | null;
  providerMeta: Record<string, unknown> | null;
}

export function classifyCodexAppServerError(
  error: unknown,
  metadata: RuntimeExecutionErrorMetadata = {},
): CodexRuntimeAdapterError {
  if (error instanceof CodexRuntimeAdapterError) {
    return error;
  }

  const info = extractCodexAppServerErrorInfo(error);
  const category =
    info.category ??
    (typeof info.httpStatusCode === "number" ? classifyByHttpStatus(info.httpStatusCode) : null) ??
    (info.structuredCode ? STRUCTURED_CODE_TO_CATEGORY[info.structuredCode] : null) ??
    "unknown";

  if (
    info.category ||
    info.adapterCode ||
    info.structuredCode ||
    typeof info.httpStatusCode === "number"
  ) {
    const adapterCode = info.adapterCode ?? CATEGORY_TO_ADAPTER_CODE[category];
    const message = messageFromUnknown(error);
    return new CodexRuntimeAdapterError(message, adapterCode, category, error, {
      ...metadata,
      adapterCode,
      httpStatus: info.httpStatusCode ?? metadata.httpStatus,
      providerMeta: info.providerMeta ?? metadata.providerMeta ?? null,
    });
  }

  return classifyCodexRuntimeError(error, metadata.httpStatus, metadata);
}

export function extractCodexAppServerErrorInfo(error: unknown): CodexAppServerErrorInfo {
  const fromJsonlError = error instanceof JsonlRpcResponseError ? asRecord(error.rpcData) : null;
  const fromDirectError = error && typeof error === "object" ? asRecord(error) : null;
  const rawCodexInfo = fromJsonlError?.codexErrorInfo ?? fromDirectError?.codexErrorInfo ?? null;
  const fromCodexInfo = asRecord(rawCodexInfo);
  const codexInfoDetails = readCodexErrorInfoDetails(fromCodexInfo?.codexErrorInfo ?? rawCodexInfo);
  const providerMeta =
    fromJsonlError ??
    (fromDirectError && Object.keys(fromDirectError).length > 0 ? fromDirectError : null);

  const category =
    readCategory(
      fromCodexInfo?.category ??
        fromJsonlError?.category ??
        fromDirectError?.category ??
        fromJsonlError?.errorCategory ??
        fromDirectError?.errorCategory,
    ) ?? codexInfoDetails.category;
  const adapterCode = readString(
    fromCodexInfo?.adapterCode ??
      fromJsonlError?.adapterCode ??
      fromDirectError?.adapterCode ??
      fromJsonlError?.code ??
      fromDirectError?.code,
  );
  const structuredCode = readString(
    fromCodexInfo?.code ??
      fromJsonlError?.codexCode ??
      fromDirectError?.codexCode ??
      codexInfoDetails.structuredCode,
  );
  const httpStatusCode = readNumber(
    fromCodexInfo?.httpStatusCode ??
      fromCodexInfo?.httpStatus ??
      fromJsonlError?.httpStatusCode ??
      fromJsonlError?.httpStatus ??
      fromDirectError?.httpStatusCode ??
      fromDirectError?.httpStatus ??
      codexInfoDetails.httpStatusCode,
  );

  return {
    category,
    adapterCode,
    structuredCode,
    httpStatusCode,
    providerMeta,
  };
}

function readCodexErrorInfoDetails(value: unknown): {
  category: RuntimeErrorCategory | null;
  structuredCode: string | null;
  httpStatusCode: number | null;
} {
  const variant = readCodexErrorInfoVariant(value);
  if (!variant) {
    return { category: null, structuredCode: null, httpStatusCode: null };
  }
  const structuredCode = camelToUpperSnake(variant.name);
  return {
    category: STRUCTURED_CODE_TO_CATEGORY[structuredCode] ?? null,
    structuredCode,
    httpStatusCode: variant.httpStatusCode,
  };
}

function readCodexErrorInfoVariant(value: unknown): {
  name: string;
  httpStatusCode: number | null;
} | null {
  const stringValue = readString(value);
  if (stringValue) {
    return { name: stringValue, httpStatusCode: null };
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const [name, detail] = Object.entries(record)[0] ?? [];
  if (!name) {
    return null;
  }
  return {
    name,
    httpStatusCode: readNumber(asRecord(detail)?.httpStatusCode),
  };
}

function camelToUpperSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCategory(value: unknown): RuntimeErrorCategory | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim() as RuntimeErrorCategory;
  return RUNTIME_ERROR_CATEGORIES.has(normalized) ? normalized : null;
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
