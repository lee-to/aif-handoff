import type { RuntimeLimitScope, RuntimeLimitSnapshot, RuntimeLimitWindow } from "./types.js";

const REDACTED_VALUE = "[REDACTED]";
const MAX_PROVIDER_META_BYTES = 4096;
const MAX_PROVIDER_META_DEPTH = 4;
const MAX_PROVIDER_META_OBJECT_KEYS = 24;
const MAX_PROVIDER_META_ARRAY_ITEMS = 24;
const MAX_PROVIDER_META_STRING_LENGTH = 256;

function normalizeMetaKey(value: string): string {
  return value.trim().toLowerCase();
}

function toNormalizedKeySet(values: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(values.map((value) => normalizeMetaKey(value)));
}

const GENERIC_ALLOWED_PROVIDER_META_KEYS = toNormalizedKeySet([
  "status",
  "reason",
  "category",
  "providerFamily",
  "providerLabel",
  "planType",
  "accountId",
  "accountName",
  "accountLabel",
  "accountFingerprint",
  "isUsingOverage",
  "surpassedThreshold",
  "rateLimitType",
  "retryAfterSeconds",
  "resetAt",
  "windowHours",
  "modelUsageSummary",
  "toolUsageSummary",
]);

const PROVIDER_META_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  anthropic: toNormalizedKeySet([
    "providerFamily",
    "providerLabel",
    "planType",
    "accountId",
    "accountName",
    "accountLabel",
    "accountFingerprint",
    "isUsingOverage",
    "surpassedThreshold",
    "rateLimitType",
    "retryAfterSeconds",
    "resetAt",
    "modelUsageSummary",
    "toolUsageSummary",
  ]),
  claude: toNormalizedKeySet([
    "providerFamily",
    "providerLabel",
    "planType",
    "accountId",
    "accountName",
    "accountLabel",
    "accountFingerprint",
    "isUsingOverage",
    "surpassedThreshold",
    "rateLimitType",
    "retryAfterSeconds",
    "resetAt",
    "modelUsageSummary",
    "toolUsageSummary",
  ]),
  openai: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
  ]),
  openrouter: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
  ]),
  codex: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
  ]),
};

const FORBIDDEN_PROVIDER_META_KEYS = toNormalizedKeySet([
  "headers",
  "header",
  "body",
  "raw",
  "response",
  "request",
  "payload",
  "stderr",
  "stdout",
  "stack",
  "trace",
  "traceback",
  "dump",
  "diagnostics",
  "debug",
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "secret_token",
  "password",
  "credentials",
]);

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_\-]{6,}\b/gi,
  /\b(?:api[_-]?key|token|secret[_-]?token|authorization|password)\s*[:=]\s*["']?[^\s,"']+["']?/gi,
  /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeProviderId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function redactSensitiveText(raw: string): string {
  let redacted = raw;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_VALUE);
  }
  if (redacted.length > MAX_PROVIDER_META_STRING_LENGTH) {
    return `${redacted.slice(0, MAX_PROVIDER_META_STRING_LENGTH)}...`;
  }
  return redacted;
}

function sanitizeProviderMetaValue(value: unknown, depth: number): unknown {
  if (depth > MAX_PROVIDER_META_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    for (const item of value.slice(0, MAX_PROVIDER_META_ARRAY_ITEMS)) {
      sanitized.push(sanitizeProviderMetaValue(item, depth + 1));
    }
    if (value.length > MAX_PROVIDER_META_ARRAY_ITEMS) {
      sanitized.push("[TRUNCATED_ARRAY]");
    }
    return sanitized;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const sanitizedObject: Record<string, unknown> = {};
    for (const [key, nestedValue] of entries.slice(0, MAX_PROVIDER_META_OBJECT_KEYS)) {
      const normalizedKey = normalizeMetaKey(key);
      if (FORBIDDEN_PROVIDER_META_KEYS.has(normalizedKey)) {
        continue;
      }
      sanitizedObject[key] = sanitizeProviderMetaValue(nestedValue, depth + 1);
    }
    if (entries.length > MAX_PROVIDER_META_OBJECT_KEYS) {
      sanitizedObject._truncated = true;
    }
    return sanitizedObject;
  }
  return String(value);
}

function stableSortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObjectKeys(item));
  }
  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableSortObjectKeys(nested)] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

function normalizeWindowForSignature(window: RuntimeLimitWindow): Record<string, unknown> {
  return {
    scope: window.scope,
    name: window.name ?? null,
    unit: window.unit ?? null,
    limit: toFiniteNumber(window.limit),
    remaining: toFiniteNumber(window.remaining),
    used: toFiniteNumber(window.used),
    percentUsed: toFiniteNumber(window.percentUsed),
    percentRemaining: toFiniteNumber(window.percentRemaining),
    resetAt: window.resetAt ?? null,
    retryAfterSeconds: toFiniteNumber(window.retryAfterSeconds),
    warningThreshold: toFiniteNumber(window.warningThreshold),
  };
}

function windowSortKey(window: Record<string, unknown>): string {
  return [
    String(window.scope ?? ""),
    String(window.name ?? ""),
    String(window.unit ?? ""),
    String(window.limit ?? ""),
    String(window.remaining ?? ""),
    String(window.used ?? ""),
    String(window.percentRemaining ?? ""),
    String(window.resetAt ?? ""),
    String(window.retryAfterSeconds ?? ""),
  ].join("|");
}

function choosePrimaryWindow(snapshot: RuntimeLimitSnapshot): RuntimeLimitWindow | null {
  if (!snapshot.windows.length) return null;
  if (snapshot.primaryScope) {
    const scoped = snapshot.windows.find((window) => window.scope === snapshot.primaryScope);
    if (scoped) return scoped;
  }
  return (
    snapshot.windows.find(
      (window) =>
        window.resetAt != null ||
        isFiniteNonNegative(window.retryAfterSeconds) ||
        toFiniteNumber(window.percentRemaining) != null,
    ) ?? snapshot.windows[0]!
  );
}

export type RuntimeLimitFutureHintSource =
  | "snapshot_reset_at"
  | "snapshot_retry_after"
  | "window_reset_at"
  | "window_retry_after"
  | "none";

export interface RuntimeLimitFutureHint {
  source: RuntimeLimitFutureHintSource;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  resetAtMs: number | null;
  isFuture: boolean;
  windowScope: RuntimeLimitScope | null;
}

interface HintCandidate {
  source: RuntimeLimitFutureHintSource;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  windowScope: RuntimeLimitScope | null;
}

function candidateFromResetAt(
  source: RuntimeLimitFutureHintSource,
  resetAt: string | null | undefined,
  windowScope: RuntimeLimitScope | null,
): HintCandidate | null {
  if (!resetAt) return null;
  return {
    source,
    resetAt,
    retryAfterSeconds: null,
    windowScope,
  };
}

function candidateFromRetryAfter(
  source: RuntimeLimitFutureHintSource,
  retryAfterSeconds: number | null | undefined,
  windowScope: RuntimeLimitScope | null,
  nowMs: number,
): HintCandidate | null {
  if (!isFiniteNonNegative(retryAfterSeconds)) return null;
  return {
    source,
    resetAt: new Date(nowMs + retryAfterSeconds * 1000).toISOString(),
    retryAfterSeconds,
    windowScope,
  };
}

export function selectViolatedWindowForExactThreshold(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  thresholdOverride?: number | null,
  nowMs = Date.now(),
): RuntimeLimitWindow | null {
  if (!snapshot || snapshot.precision !== "exact") return null;

  const fallbackThreshold = toFiniteNumber(thresholdOverride ?? snapshot.warningThreshold);
  const violated = snapshot.windows.filter((window) => {
    const percentRemaining = toFiniteNumber(window.percentRemaining);
    const threshold = toFiniteNumber(window.warningThreshold ?? fallbackThreshold);
    return percentRemaining != null && threshold != null && percentRemaining <= threshold;
  });

  if (violated.length === 0) {
    return null;
  }

  const score = (window: RuntimeLimitWindow): number => {
    const resetAtMs = parseTimestampMs(window.resetAt);
    if (resetAtMs != null) return resetAtMs;
    if (isFiniteNonNegative(window.retryAfterSeconds)) {
      return nowMs + window.retryAfterSeconds * 1000;
    }
    return Number.NEGATIVE_INFINITY;
  };

  return violated.reduce(
    (best, candidate) => {
      if (!best) return candidate;
      const bestScore = score(best);
      const candidateScore = score(candidate);
      if (candidateScore > bestScore) return candidate;
      if (candidateScore < bestScore) return best;

      const bestRemaining = toFiniteNumber(best.percentRemaining) ?? Number.POSITIVE_INFINITY;
      const candidateRemaining =
        toFiniteNumber(candidate.percentRemaining) ?? Number.POSITIVE_INFINITY;
      return candidateRemaining < bestRemaining ? candidate : best;
    },
    null as RuntimeLimitWindow | null,
  );
}

export function resolveRuntimeLimitFutureHint(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  input: {
    nowMs?: number;
    preferredWindow?: RuntimeLimitWindow | null;
    windowFirst?: boolean;
  } = {},
): RuntimeLimitFutureHint {
  const nowMs = input.nowMs ?? Date.now();
  if (!snapshot) {
    return {
      source: "none",
      resetAt: null,
      retryAfterSeconds: null,
      resetAtMs: null,
      isFuture: false,
      windowScope: null,
    };
  }

  const preferredWindow = input.preferredWindow ?? choosePrimaryWindow(snapshot);
  const windowScope = preferredWindow?.scope ?? null;

  const snapshotCandidates = [
    candidateFromResetAt("snapshot_reset_at", snapshot.resetAt, null),
    candidateFromRetryAfter("snapshot_retry_after", snapshot.retryAfterSeconds, null, nowMs),
  ];
  const windowCandidates = [
    candidateFromResetAt("window_reset_at", preferredWindow?.resetAt, windowScope),
    candidateFromRetryAfter(
      "window_retry_after",
      preferredWindow?.retryAfterSeconds,
      windowScope,
      nowMs,
    ),
  ];

  const ordered = (
    input.windowFirst
      ? [...windowCandidates, ...snapshotCandidates]
      : [...snapshotCandidates, ...windowCandidates]
  ).filter((candidate): candidate is HintCandidate => candidate != null);

  const selected = ordered[0];
  if (!selected) {
    return {
      source: "none",
      resetAt: null,
      retryAfterSeconds: null,
      resetAtMs: null,
      isFuture: false,
      windowScope: null,
    };
  }

  const resetAtMs = parseTimestampMs(selected.resetAt);
  return {
    source: selected.source,
    resetAt: selected.resetAt,
    retryAfterSeconds: selected.retryAfterSeconds,
    resetAtMs,
    isFuture: resetAtMs != null && resetAtMs > nowMs,
    windowScope: selected.windowScope,
  };
}

export function sanitizeProviderMeta(
  providerId: string | null | undefined,
  providerMeta: unknown,
): Record<string, unknown> | null {
  if (!providerMeta || typeof providerMeta !== "object" || Array.isArray(providerMeta)) {
    return null;
  }

  const normalizedProviderId = normalizeProviderId(providerId);
  const providerAllowlist = PROVIDER_META_ALLOWLIST[normalizedProviderId] ?? new Set<string>();
  const allowedKeys = new Set<string>([
    ...GENERIC_ALLOWED_PROVIDER_META_KEYS,
    ...providerAllowlist,
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerMeta as Record<string, unknown>)) {
    const normalizedKey = normalizeMetaKey(key);
    if (!allowedKeys.has(normalizedKey)) {
      continue;
    }
    if (FORBIDDEN_PROVIDER_META_KEYS.has(normalizedKey)) {
      continue;
    }
    sanitized[key] = sanitizeProviderMetaValue(value, 0);
  }

  if (Object.keys(sanitized).length === 0) {
    return null;
  }

  const serialized = JSON.stringify(stableSortObjectKeys(sanitized));
  if (estimateUtf8Bytes(serialized) > MAX_PROVIDER_META_BYTES) {
    return {
      _truncated: true,
      status:
        typeof (sanitized.status as unknown) === "string"
          ? sanitized.status
          : "provider_meta_truncated",
    };
  }

  return sanitized;
}

export function normalizeRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot,
): RuntimeLimitSnapshot {
  return {
    ...snapshot,
    providerMeta: sanitizeProviderMeta(snapshot.providerId, snapshot.providerMeta ?? null),
  };
}

export function buildRuntimeLimitSignature(snapshot: RuntimeLimitSnapshot): string {
  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  const normalizedWindows = normalizedSnapshot.windows
    .map((window) => normalizeWindowForSignature(window))
    .sort((left, right) => windowSortKey(left).localeCompare(windowSortKey(right)));

  const normalized = {
    source: normalizedSnapshot.source,
    status: normalizedSnapshot.status,
    precision: normalizedSnapshot.precision,
    providerId: normalizedSnapshot.providerId,
    runtimeId: normalizedSnapshot.runtimeId ?? null,
    profileId: normalizedSnapshot.profileId ?? null,
    primaryScope: normalizedSnapshot.primaryScope ?? null,
    resetAt: normalizedSnapshot.resetAt ?? null,
    retryAfterSeconds: toFiniteNumber(normalizedSnapshot.retryAfterSeconds),
    warningThreshold: toFiniteNumber(normalizedSnapshot.warningThreshold),
    windows: normalizedWindows,
    providerMeta: normalizedSnapshot.providerMeta ?? null,
  };

  return JSON.stringify(stableSortObjectKeys(normalized));
}

export type SafeRuntimeErrorCategory =
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

export interface SafeRuntimeErrorReason {
  reason: string;
  category: SafeRuntimeErrorCategory;
  code: string;
  isRuntimeError: boolean;
}

function safeRuntimeCategory(value: unknown): SafeRuntimeErrorCategory {
  if (typeof value !== "string") return "unknown";
  switch (value) {
    case "rate_limit":
    case "auth":
    case "timeout":
    case "permission":
    case "stream":
    case "transport":
    case "model_not_found":
    case "context_length":
    case "content_filter":
      return value;
    default:
      return "unknown";
  }
}

export function mapSafeRuntimeErrorReason(error: unknown): SafeRuntimeErrorReason {
  const category = safeRuntimeCategory(
    error && typeof error === "object" ? (error as { category?: unknown }).category : null,
  );
  const isRuntimeError = category !== "unknown";

  switch (category) {
    case "rate_limit":
      return {
        reason: "Runtime usage limit reached.",
        category,
        code: "RUNTIME_RATE_LIMIT",
        isRuntimeError,
      };
    case "auth":
      return {
        reason: "Runtime authentication failed.",
        category,
        code: "RUNTIME_AUTH_FAILED",
        isRuntimeError,
      };
    case "timeout":
      return {
        reason: "Runtime request timed out.",
        category,
        code: "RUNTIME_TIMEOUT",
        isRuntimeError,
      };
    case "permission":
      return {
        reason: "Runtime permissions blocked this task.",
        category,
        code: "RUNTIME_PERMISSION_BLOCKED",
        isRuntimeError,
      };
    case "stream":
      return {
        reason: "Runtime stream failed.",
        category,
        code: "RUNTIME_STREAM_FAILED",
        isRuntimeError,
      };
    case "transport":
      return {
        reason: "Provider temporarily unavailable.",
        category,
        code: "RUNTIME_PROVIDER_UNAVAILABLE",
        isRuntimeError,
      };
    case "model_not_found":
      return {
        reason: "Configured model was not found for the selected runtime.",
        category,
        code: "RUNTIME_MODEL_NOT_FOUND",
        isRuntimeError,
      };
    case "context_length":
      return {
        reason: "Request exceeded the model context limit.",
        category,
        code: "RUNTIME_CONTEXT_LENGTH_EXCEEDED",
        isRuntimeError,
      };
    case "content_filter":
      return {
        reason: "Request blocked by provider content policy.",
        category,
        code: "RUNTIME_CONTENT_FILTERED",
        isRuntimeError,
      };
    default:
      return {
        reason: "Runtime request failed.",
        category: "unknown",
        code: "RUNTIME_UNKNOWN_ERROR",
        isRuntimeError: false,
      };
  }
}
