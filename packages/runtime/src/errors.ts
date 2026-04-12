export class RuntimeError extends Error {
  public readonly code: string;

  constructor(message: string, code = "RUNTIME_ERROR", cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class RuntimeRegistrationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_REGISTRATION_ERROR", cause);
    this.name = "RuntimeRegistrationError";
  }
}

export class RuntimeResolutionError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_RESOLUTION_ERROR", cause);
    this.name = "RuntimeResolutionError";
  }
}

export class RuntimeModuleValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_VALIDATION_ERROR", cause);
    this.name = "RuntimeModuleValidationError";
  }
}

export class RuntimeModuleLoadError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_LOAD_ERROR", cause);
    this.name = "RuntimeModuleLoadError";
  }
}

export class RuntimeValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_VALIDATION_ERROR", cause);
    this.name = "RuntimeValidationError";
  }
}

export class RuntimeCapabilityError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_CAPABILITY_ERROR", cause);
    this.name = "RuntimeCapabilityError";
  }
}

/** Semantic error categories — adapters set this so consumers don't parse error messages. */
export type RuntimeErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "permission"
  | "stream"
  | "transport"
  | "model_not_found"
  | "context_length"
  | "content_filter"
  | "unknown";

export class RuntimeExecutionError extends RuntimeError {
  public readonly category: RuntimeErrorCategory;

  constructor(message: string, cause?: unknown, category: RuntimeErrorCategory = "unknown") {
    super(message, "RUNTIME_EXECUTION_ERROR", cause);
    this.name = "RuntimeExecutionError";
    this.category = category;
  }
}

/** Check if an error is a RuntimeExecutionError with a specific category. */
export function isRuntimeErrorCategory(err: unknown, category: RuntimeErrorCategory): boolean {
  return err instanceof RuntimeExecutionError && err.category === category;
}

// ---------------------------------------------------------------------------
// HTTP status → category mapping (single source of truth for API transports)
// ---------------------------------------------------------------------------

const HTTP_STATUS_CATEGORY_MAP: ReadonlyMap<number, RuntimeErrorCategory> = new Map([
  [401, "auth"],
  [403, "auth"],
  [429, "rate_limit"],
  [408, "timeout"],
  [504, "timeout"],
  // 404 intentionally omitted — too broad for a shared mapping. A 404 on
  // /models means "model not found", but on /chat/completions it means bad
  // baseUrl / route config. Adapters should classify 404 per-endpoint.
  [413, "context_length"],
  [451, "content_filter"],
]);

/**
 * Classify an error by HTTP status code. API transports should use this
 * as the primary classification signal — zero string matching required.
 *
 * Returns `null` when the status does not map to a known category
 * (callers should fall through to message-based fallback).
 */
export function classifyByHttpStatus(status: number): RuntimeErrorCategory | null {
  const exact = HTTP_STATUS_CATEGORY_MAP.get(status);
  if (exact) return exact;
  if (status >= 500 && status < 600) return "transport";
  return null;
}

// ---------------------------------------------------------------------------
// Shared fallback patterns (single consolidated list, last-resort only)
// ---------------------------------------------------------------------------

/**
 * Consolidated string patterns for message-based error classification.
 * Used ONLY as a last-resort fallback when no HTTP status or structured
 * SDK signal is available (e.g., CLI transports, plain Error(string) from SDKs).
 *
 * This is the SINGLE source of truth — adapters must NOT maintain their own
 * pattern arrays. See CHECKLIST.md "No string-based error classification" rule.
 */
const SHARED_FALLBACK_PATTERNS: ReadonlyArray<{
  category: RuntimeErrorCategory;
  patterns: readonly string[];
}> = [
  {
    category: "rate_limit",
    patterns: [
      "usage limit",
      "out of extra usage",
      "rate limit",
      "rate_limit",
      "too many requests",
      "insufficient_quota",
      "quota",
      "at capacity",
      "model is at capacity",
      "hit your limit",
      "limit reached",
      "limit exceeded",
      "out of credits",
      "credits",
    ],
  },
  {
    category: "auth",
    patterns: [
      "authentication_error",
      "invalid authentication credentials",
      "failed to authenticate",
      "unauthorized",
      "invalid api key",
      "invalid_api_key",
      "invalid credentials",
      "invalid password",
      "forbidden",
      "not logged in",
    ],
  },
  {
    category: "timeout",
    patterns: [
      "timed out",
      "timeout",
      "etimedout",
      "aborted",
      "query_start_timeout",
      "first_activity_timeout",
    ],
  },
  {
    category: "permission",
    patterns: ["permission denied", "write permission", "blocked by permissions"],
  },
  {
    category: "stream",
    patterns: ["stream_error", "stream closed", "stream interrupted"],
  },
  {
    category: "transport",
    patterns: ["connection refused", "econnrefused", "econnreset", "network", "fetch failed"],
  },
  {
    category: "model_not_found",
    patterns: [
      "model not found",
      "no endpoints found",
      "model_not_available",
      "no available model",
      "providermodelnotfounderror",
      "modelnotfounderror",
      "provider not found",
    ],
  },
  {
    category: "context_length",
    patterns: ["context_length_exceeded", "maximum context length"],
  },
  {
    category: "content_filter",
    patterns: ["content_filter", "content_policy"],
  },
];

/**
 * Classify an error by message string matching. This is the LAST-RESORT
 * fallback — callers must prefer `classifyByHttpStatus` or structured
 * SDK signals before reaching this function.
 */
export function classifyByMessageFallback(message: string): RuntimeErrorCategory {
  const lowered = message.toLowerCase();
  for (const entry of SHARED_FALLBACK_PATTERNS) {
    if (entry.patterns.some((p) => lowered.includes(p))) {
      return entry.category;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// External failure category check (for agent/coordinator consumption)
// ---------------------------------------------------------------------------

/** Categories that indicate a provider/external issue (not a bug in the task). */
const EXTERNAL_FAILURE_CATEGORIES: ReadonlySet<RuntimeErrorCategory> = new Set([
  "rate_limit",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
]);

/**
 * Returns true if the category indicates an external/provider issue
 * rather than a bug in the task itself. Used by the agent coordinator
 * to decide between "blocked_external" (backoff + retry) and "revert".
 */
export function isExternalFailureCategory(category: RuntimeErrorCategory): boolean {
  return EXTERNAL_FAILURE_CATEGORIES.has(category);
}
