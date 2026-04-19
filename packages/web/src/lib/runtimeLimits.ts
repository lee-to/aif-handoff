import type {
  RuntimeLimitScope,
  RuntimeLimitSnapshot,
  RuntimeLimitWindow,
  RuntimeLimitFutureHint,
} from "@aif/shared/browser";
import { resolveRuntimeLimitFutureHint } from "@aif/shared/browser";

export type RuntimeLimitTone = "success" | "warning" | "error" | "info";
export type RuntimeLimitDisplayState = "active" | "expired" | "signal_no_reset" | "historical";

export interface RuntimeLimitDisplay {
  state: RuntimeLimitDisplayState;
  tone: RuntimeLimitTone;
  isExpired: boolean;
  label: string;
  shortLabel: string;
  summary: string;
  detail: string | null;
  resetAt: string | null; // provider reset hint
  resetText: string | null;
  taskRetryAt: string | null;
  taskRetryText: string | null;
  hintSource: RuntimeLimitFutureHint["source"];
  checkedAt: string | null;
  checkedText: string | null;
}

interface RuntimeLimitDisplayOptions {
  taskRetryAfter?: string | null;
  checkedAt?: string | null;
  nowMs?: number;
  freshnessMs?: number;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const DEFAULT_FRESHNESS_MS = 30 * 60_000;

function toFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number): string {
  const rounded = value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded}%`;
}

function formatQuantity(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelativeAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)} min ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.round(ageMs / (60 * 60_000))}h ago`;
  return `${Math.round(ageMs / (24 * 60 * 60_000))}d ago`;
}

function scopeLabel(scope: RuntimeLimitScope | null | undefined): string {
  switch (scope) {
    case "requests":
      return "request quota";
    case "tokens":
      return "token quota";
    case "time":
      return "runtime window";
    case "spend":
      return "spend quota";
    case "turn_usage":
      return "turn usage";
    case "model_usage":
      return "model usage";
    case "tool_usage":
      return "tool usage";
    default:
      return "runtime quota";
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function hasWindowSignal(window: RuntimeLimitWindow): boolean {
  return [
    window.percentRemaining,
    window.percentUsed,
    window.remaining,
    window.used,
    window.limit,
    window.resetAt,
    window.retryAfterSeconds,
  ].some((value) => value !== null && value !== undefined);
}

function selectPrimaryWindow(snapshot: RuntimeLimitSnapshot): RuntimeLimitWindow | null {
  if (!snapshot.windows.length) return null;
  if (snapshot.primaryScope) {
    const primary = snapshot.windows.find((window) => window.scope === snapshot.primaryScope);
    if (primary) return primary;
  }
  return snapshot.windows.find(hasWindowSignal) ?? snapshot.windows[0] ?? null;
}

function summarizeWindow(
  snapshot: RuntimeLimitSnapshot,
  window: RuntimeLimitWindow | null,
): string {
  const scope = capitalize(scopeLabel(window?.scope ?? snapshot.primaryScope));
  const percentRemaining = toFiniteNumber(window?.percentRemaining);
  const percentUsed = toFiniteNumber(window?.percentUsed);
  const remaining = toFiniteNumber(window?.remaining);
  const limit = toFiniteNumber(window?.limit);
  const used = toFiniteNumber(window?.used);
  const warningThreshold = toFiniteNumber(window?.warningThreshold ?? snapshot.warningThreshold);
  const isUsingOverage = snapshot.providerMeta?.isUsingOverage === true;
  const surpassedThreshold = snapshot.providerMeta?.surpassedThreshold === true;

  if (snapshot.status === "blocked") {
    if (percentRemaining !== null && warningThreshold !== null) {
      return `${scope} crossed the ${formatPercent(warningThreshold)} safety threshold (${formatPercent(percentRemaining)} remaining).`;
    }
    if (percentRemaining !== null) {
      return `${scope} is blocked at ${formatPercent(percentRemaining)} remaining.`;
    }
    if (remaining !== null && limit !== null) {
      return `${scope} is blocked with ${formatQuantity(remaining)} of ${formatQuantity(limit)} remaining.`;
    }
    if (remaining !== null) {
      return `${scope} is blocked with ${formatQuantity(remaining)} remaining.`;
    }
    if (isUsingOverage) {
      return "Provider reported overage capacity is exhausted.";
    }
    return "Provider reported this runtime is currently blocked by usage limits.";
  }

  if (snapshot.status === "warning") {
    if (percentRemaining !== null && warningThreshold !== null) {
      return `${scope} is at ${formatPercent(percentRemaining)} remaining (threshold ${formatPercent(warningThreshold)}).`;
    }
    if (percentRemaining !== null) {
      return `${scope} is at ${formatPercent(percentRemaining)} remaining.`;
    }
    if (remaining !== null && limit !== null) {
      return `${scope} has ${formatQuantity(remaining)} of ${formatQuantity(limit)} remaining.`;
    }
    if (percentUsed !== null) {
      return `${scope} is at ${formatPercent(percentUsed)} used.`;
    }
    if (used !== null && limit !== null) {
      return `${scope} is using ${formatQuantity(used)} of ${formatQuantity(limit)}.`;
    }
    if (isUsingOverage) {
      return "Provider reported overage mode is active.";
    }
    if (surpassedThreshold) {
      return "Provider reported this runtime has crossed its warning threshold.";
    }
    return "Provider reported this runtime is approaching its usage limit.";
  }

  if (snapshot.status === "ok") {
    if (percentRemaining !== null) {
      return `${scope} is healthy at ${formatPercent(percentRemaining)} remaining.`;
    }
    if (remaining !== null && limit !== null) {
      return `${scope} has ${formatQuantity(remaining)} of ${formatQuantity(limit)} remaining.`;
    }
    return "Provider reported this runtime is currently healthy.";
  }

  return "Provider did not provide enough detail to summarize current runtime limit state.";
}

export function getRuntimeLimitDisplay(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  options: RuntimeLimitDisplayOptions = {},
): RuntimeLimitDisplay | null {
  if (!snapshot) return null;

  const window = selectPrimaryWindow(snapshot);
  const nowMs = options.nowMs ?? Date.now();
  const futureHint = resolveRuntimeLimitFutureHint(snapshot, {
    nowMs,
    preferredWindow: window,
  });
  const resetAt = futureHint.resetAt;
  const retryAfterSeconds =
    futureHint.retryAfterSeconds ?? snapshot.retryAfterSeconds ?? window?.retryAfterSeconds ?? null;
  const taskRetryAt = options.taskRetryAfter ?? null;
  const taskRetryAtMs = parseTimestampMs(taskRetryAt);
  const taskRetryLabel = formatTimestamp(taskRetryAt);
  const checkedAt = options.checkedAt ?? snapshot.checkedAt ?? null;
  const checkedAtMs = parseTimestampMs(checkedAt);
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const isActiveLimitSignal = snapshot.status === "blocked" || snapshot.status === "warning";
  const isFresh = checkedAtMs != null ? nowMs - checkedAtMs <= freshnessMs : false;

  const displayState: RuntimeLimitDisplayState = isActiveLimitSignal
    ? futureHint.isFuture
      ? "active"
      : futureHint.resetAtMs != null
        ? "expired"
        : "signal_no_reset"
    : isFresh
      ? "active"
      : "historical";

  const resetLabel = formatTimestamp(resetAt);
  const checkedLabel = formatTimestamp(checkedAt);
  const checkedText =
    checkedAtMs != null
      ? `Last checked ${formatRelativeAge(Math.max(0, nowMs - checkedAtMs))}${checkedLabel ? ` (${checkedLabel})` : ""}.`
      : checkedLabel
        ? `Last checked ${checkedLabel}.`
        : null;
  const taskRetryText =
    taskRetryAtMs == null
      ? null
      : taskRetryAtMs > nowMs
        ? `Task retry is scheduled for ${taskRetryLabel}.`
        : `Task retry was scheduled for ${taskRetryLabel}.`;

  if (displayState === "expired") {
    return {
      state: "expired",
      tone: "info",
      isExpired: true,
      label: "Expired",
      shortLabel: "EXPIRED",
      summary: "The provider reset window has elapsed. Waiting for a fresh limit signal.",
      detail: "This persisted provider signal is no longer treated as an active runtime block.",
      resetAt,
      resetText: resetLabel ? `Provider reset window elapsed ${resetLabel}.` : null,
      taskRetryAt,
      taskRetryText,
      hintSource: futureHint.source,
      checkedAt,
      checkedText,
    };
  }

  if (displayState === "signal_no_reset") {
    return {
      state: "signal_no_reset",
      tone: "info",
      isExpired: false,
      label: "Signal Without Reset",
      shortLabel: "NO RESET",
      summary: "Limit signal observed without a future reset hint. Auto-pause is disabled.",
      detail:
        "Provider limit state and task retry schedule are shown separately until a future provider reset hint is available.",
      resetAt,
      resetText: null,
      taskRetryAt,
      taskRetryText,
      hintSource: futureHint.source,
      checkedAt,
      checkedText,
    };
  }

  if (displayState === "historical") {
    const historicalSummary =
      snapshot.status === "ok"
        ? "Last known healthy state. Waiting for a recent provider signal."
        : snapshot.status === "unknown"
          ? "No recent provider limit signal is available."
          : "Last known provider limit signal is stale.";
    const historicalLabel =
      snapshot.status === "ok"
        ? "Last Known Healthy"
        : snapshot.status === "unknown"
          ? "No Recent Signal"
          : "Historical Signal";
    const historicalShortLabel =
      snapshot.status === "ok"
        ? "LAST KNOWN"
        : snapshot.status === "unknown"
          ? "NO SIGNAL"
          : "HIST";
    return {
      state: "historical",
      tone: "info",
      isExpired: false,
      label: historicalLabel,
      shortLabel: historicalShortLabel,
      summary: historicalSummary,
      detail: summarizeWindow(snapshot, window),
      resetAt,
      resetText: resetLabel ? `Provider reset ${resetLabel}.` : null,
      taskRetryAt,
      taskRetryText,
      hintSource: futureHint.source,
      checkedAt,
      checkedText,
    };
  }

  const tone: RuntimeLimitTone =
    snapshot.status === "blocked"
      ? "error"
      : snapshot.status === "warning"
        ? "warning"
        : snapshot.status === "ok"
          ? "success"
          : "info";
  const label =
    snapshot.status === "blocked"
      ? "Blocked"
      : snapshot.status === "warning"
        ? "Near Limit"
        : snapshot.status === "ok"
          ? "Healthy"
          : "Unknown";
  const shortLabel =
    snapshot.status === "blocked"
      ? "BLOCKED"
      : snapshot.status === "warning"
        ? "LIMIT"
        : snapshot.status === "ok"
          ? "OK"
          : "UNKNOWN";

  return {
    state: "active",
    tone,
    isExpired: false,
    label,
    shortLabel,
    summary: summarizeWindow(snapshot, window),
    detail:
      snapshot.precision === "exact"
        ? "Uses an exact quota signal from the provider."
        : "Uses a provider status signal rather than an exact remaining count.",
    resetAt,
    resetText: resetLabel
      ? `Provider reset ${resetLabel}.`
      : typeof retryAfterSeconds === "number"
        ? `Provider retry after ${Math.max(0, Math.round(retryAfterSeconds))}s.`
        : null,
    taskRetryAt,
    taskRetryText,
    hintSource: futureHint.source,
    checkedAt,
    checkedText,
  };
}

export function runtimeLimitBadgeClassName(tone: RuntimeLimitTone): string {
  switch (tone) {
    case "error":
      return "border-destructive/35 bg-destructive/10 text-destructive";
    case "warning":
      return "border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "success":
      return "border-emerald-500/35 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-border bg-secondary/60 text-muted-foreground";
  }
}
