import { logger } from "@aif/shared";
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "./types.js";

const DEFAULT_WARNING_THRESHOLD = 10;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const EPOCH_SECONDS_MIN = 1_000_000_000;
const EPOCH_MILLISECONDS_MIN = 1_000_000_000_000;
const EPOCH_MILLISECONDS_MAX = 9_999_999_999_999;
const log = logger("openai-rate-limits");

interface BuildOpenAiCompatibleLimitSnapshotInput {
  providerId: string;
  runtimeId: string;
  profileId?: string | null;
  checkedAt?: string;
  statusOverride?: RuntimeLimitStatus;
  retryAfterHeader?: string | null;
}

function readFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPercentRemaining(limit: number | null, remaining: number | null): number | null {
  if (limit == null || remaining == null || limit <= 0) return null;
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

function toSafeIsoTimestamp(
  targetMs: number,
  context: { raw: string; kind: "reset" | "retry_after"; durationMs: number },
): string | null {
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    log.warn(
      {
        raw: context.raw,
        kind: context.kind,
        durationMs: context.durationMs,
        targetMs,
      },
      "Dropping invalid OpenAI-compatible reset hint",
    );
    return null;
  }

  const date = new Date(targetMs);
  if (Number.isNaN(date.getTime())) {
    log.warn(
      {
        raw: context.raw,
        kind: context.kind,
        durationMs: context.durationMs,
        targetMs,
      },
      "Dropping invalid OpenAI-compatible reset hint",
    );
    return null;
  }

  return date.toISOString();
}

function parseDurationLikeMs(raw: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  let totalMs = 0;
  let matchCount = 0;
  const normalized = raw.replace(/\s+/g, "");
  let consumed = "";

  for (const match of normalized.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount)) return null;
    matchCount += 1;
    consumed += match[0];

    switch (unit) {
      case "ms":
        totalMs += amount;
        break;
      case "s":
        totalMs += amount * 1000;
        break;
      case "m":
        totalMs += amount * 60_000;
        break;
      case "h":
        totalMs += amount * 3_600_000;
        break;
      case "d":
        totalMs += amount * 86_400_000;
        break;
      default:
        return null;
    }
  }

  if (matchCount === 0 || consumed !== normalized) {
    return null;
  }

  return totalMs;
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // Retry-After numeric semantics: duration in seconds.
    return numeric * 1000;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  const durationMs = parseDurationLikeMs(trimmed);
  if (durationMs == null) {
    return null;
  }

  return durationMs;
}

function parseRateLimitResetMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (numeric >= EPOCH_MILLISECONDS_MIN && numeric <= EPOCH_MILLISECONDS_MAX) {
      return Math.max(0, numeric - Date.now());
    }
    if (numeric >= EPOCH_SECONDS_MIN) {
      return Math.max(0, numeric * 1000 - Date.now());
    }
    // Low numeric reset header is treated as duration in seconds.
    return numeric * 1000;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return parseDurationLikeMs(trimmed);
}

function parseResetAtIso(raw: string | null): string | null {
  const durationMs = parseRateLimitResetMs(raw);
  if (durationMs == null) return null;
  const normalizedRaw = raw ?? "";
  return toSafeIsoTimestamp(Date.now() + durationMs, {
    raw: normalizedRaw,
    kind: "reset",
    durationMs,
  });
}

function parseRetryAfterSeconds(raw: string | null): number | null {
  const durationMs = parseRetryAfterMs(raw);
  if (durationMs == null) return null;
  const normalizedRaw = raw ?? "";
  const retryAtIso = toSafeIsoTimestamp(Date.now() + durationMs, {
    raw: normalizedRaw,
    kind: "retry_after",
    durationMs,
  });
  if (!retryAtIso) return null;
  return Math.max(0, Math.ceil(durationMs / 1000));
}

function pickLatestIso(values: Array<string | null | undefined>): string | null {
  const parsed = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  if (parsed.length === 0) return null;
  return new Date(parsed[0]!).toISOString();
}

function buildWindow(
  headers: Headers,
  scope: RuntimeLimitScope,
  limitHeader: string,
  remainingHeader: string,
  resetHeader: string,
): RuntimeLimitWindow | null {
  const limit = readFiniteNumber(headers.get(limitHeader));
  const remaining = readFiniteNumber(headers.get(remainingHeader));
  const resetAt = parseResetAtIso(headers.get(resetHeader));
  if (limit == null && remaining == null && resetAt == null) {
    return null;
  }

  const used = limit != null && remaining != null ? Math.max(0, limit - remaining) : null;
  const percentRemaining = toPercentRemaining(limit, remaining);
  const percentUsed =
    percentRemaining != null ? Math.max(0, Math.min(100, 100 - percentRemaining)) : null;

  return {
    scope,
    limit,
    remaining,
    used,
    percentUsed,
    percentRemaining,
    resetAt,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
  };
}

function resolveStatus(
  windows: RuntimeLimitWindow[],
  statusOverride?: RuntimeLimitStatus,
): RuntimeLimitStatus {
  if (statusOverride) return statusOverride;
  if (windows.some((window) => window.remaining === 0)) {
    return RuntimeLimitStatus.BLOCKED;
  }
  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
    )
  ) {
    return RuntimeLimitStatus.WARNING;
  }
  if (windows.length > 0) {
    return RuntimeLimitStatus.OK;
  }
  return RuntimeLimitStatus.UNKNOWN;
}

function resolvePrimaryScope(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitScope | null {
  if (windows.length === 0) return null;
  if (status === RuntimeLimitStatus.BLOCKED) {
    return windows.find((window) => window.remaining === 0)?.scope ?? windows[0]!.scope;
  }
  if (status === RuntimeLimitStatus.WARNING) {
    return (
      windows.find(
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      )?.scope ?? windows[0]!.scope
    );
  }
  return windows[0]!.scope;
}

function pickWindowByLatestReset(
  windows: RuntimeLimitWindow[],
  predicate: (window: RuntimeLimitWindow) => boolean,
): RuntimeLimitWindow | null {
  const matching = windows.filter(predicate);
  if (matching.length === 0) return null;

  const score = (window: RuntimeLimitWindow): number => {
    if (typeof window.resetAt === "string") {
      const parsed = Date.parse(window.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };

  return matching.reduce(
    (best, candidate) => {
      if (!best) return candidate;
      const bestScore = score(best);
      const candidateScore = score(candidate);
      if (candidateScore > bestScore) return candidate;
      if (candidateScore < bestScore) return best;

      const bestRemaining =
        typeof best.percentRemaining === "number"
          ? best.percentRemaining
          : Number.POSITIVE_INFINITY;
      const candidateRemaining =
        typeof candidate.percentRemaining === "number"
          ? candidate.percentRemaining
          : Number.POSITIVE_INFINITY;
      return candidateRemaining < bestRemaining ? candidate : best;
    },
    null as RuntimeLimitWindow | null,
  );
}

function resolvePrimaryWindow(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitWindow | null {
  if (windows.length === 0) return null;
  if (status === RuntimeLimitStatus.BLOCKED) {
    return (
      pickWindowByLatestReset(windows, (window) => window.remaining === 0) ??
      windows.find((window) => window.remaining === 0) ??
      windows[0]!
    );
  }
  if (status === RuntimeLimitStatus.WARNING) {
    return (
      pickWindowByLatestReset(
        windows,
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      ) ??
      windows.find(
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      ) ??
      windows[0]!
    );
  }
  return windows[0]!;
}

export function buildOpenAiCompatibleLimitSnapshot(
  headers: Headers,
  input: BuildOpenAiCompatibleLimitSnapshotInput,
): RuntimeLimitSnapshot | null {
  const retryAfterHeader = input.retryAfterHeader ?? headers.get("retry-after");
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
  const retryAfterResetAt =
    retryAfterHeader && retryAfterSeconds != null
      ? toSafeIsoTimestamp(Date.now() + retryAfterSeconds * 1000, {
          raw: retryAfterHeader,
          kind: "retry_after",
          durationMs: retryAfterSeconds * 1000,
        })
      : null;
  const requestWindow = buildWindow(
    headers,
    RuntimeLimitScope.REQUESTS,
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  );
  const tokenWindow = buildWindow(
    headers,
    RuntimeLimitScope.TOKENS,
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  );

  const windows = [requestWindow, tokenWindow].filter(
    (window): window is RuntimeLimitWindow => window != null,
  );

  if (windows.length === 0 && retryAfterSeconds == null) {
    return null;
  }

  const status = resolveStatus(windows, input.statusOverride);
  const primaryWindow = resolvePrimaryWindow(windows, status);
  const resetAt =
    primaryWindow?.resetAt ??
    (primaryWindow
      ? pickLatestIso(
          windows
            .filter((window) => window.scope === primaryWindow.scope)
            .map((window) => window.resetAt),
        )
      : null) ??
    retryAfterResetAt;

  return {
    source: RuntimeLimitSource.API_HEADERS,
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: primaryWindow?.scope ?? resolvePrimaryScope(windows, status),
    resetAt,
    retryAfterSeconds,
    warningThreshold: windows.some((window) => window.percentRemaining != null)
      ? DEFAULT_WARNING_THRESHOLD
      : null,
    windows,
    providerMeta: null,
  };
}
