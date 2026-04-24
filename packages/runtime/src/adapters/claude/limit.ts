import { logger } from "@aif/shared";
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "../../types.js";
import type { ClaudeProviderIdentity } from "./providerIdentity.js";

type ClaudeRateLimitStatus = "allowed" | "allowed_warning" | "rejected";
type ClaudeRateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "overage";

interface ClaudeRateLimitInfo {
  status?: ClaudeRateLimitStatus;
  resetsAt?: number;
  rateLimitType?: ClaudeRateLimitType;
  utilization?: number;
  overageStatus?: ClaudeRateLimitStatus;
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

interface NormalizeClaudeLimitSnapshotInput {
  info: unknown;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  checkedAt?: string;
  providerIdentity?: ClaudeProviderIdentity | null;
}

const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const log = logger("claude-limit");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTimestamp(value: number | null): string | null {
  if (value == null) return null;
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_VALID_DATE_MS) {
    log.warn(
      {
        rawValue: value,
        normalizedMs: ms,
      },
      "Dropping invalid Claude reset hint while normalizing rate-limit metadata",
    );
    return null;
  }

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    log.warn(
      {
        rawValue: value,
        normalizedMs: ms,
      },
      "Dropping invalid Claude reset hint while normalizing rate-limit metadata",
    );
    return null;
  }

  return date.toISOString();
}

function normalizeUtilizationPercent(value: number | null): number | null {
  if (value == null) return null;
  if (value >= 0 && value <= 1) {
    return value * 100;
  }
  if (value >= 0 && value <= 100) {
    return value;
  }
  return null;
}

function mapStatus(info: ClaudeRateLimitInfo): RuntimeLimitStatus {
  if (info.status === "rejected" || info.overageStatus === "rejected") {
    return RuntimeLimitStatus.BLOCKED;
  }
  if (
    info.status === "allowed_warning" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true
  ) {
    return RuntimeLimitStatus.WARNING;
  }
  if (info.status === "allowed" || info.overageStatus === "allowed") {
    return RuntimeLimitStatus.OK;
  }
  return RuntimeLimitStatus.UNKNOWN;
}

function mapScope(rateLimitType: ClaudeRateLimitType | null): RuntimeLimitScope {
  if (rateLimitType === "overage") {
    return RuntimeLimitScope.SPEND;
  }
  if (
    rateLimitType === "five_hour" ||
    rateLimitType === "seven_day" ||
    rateLimitType === "seven_day_opus" ||
    rateLimitType === "seven_day_sonnet"
  ) {
    return RuntimeLimitScope.TIME;
  }
  return RuntimeLimitScope.OTHER;
}

function resolvePrimaryRateLimitType(
  info: ClaudeRateLimitInfo,
  status: RuntimeLimitStatus,
): ClaudeRateLimitType | null {
  const baseType = info.rateLimitType ?? null;
  const overageRelevant =
    info.overageStatus === "rejected" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true;

  if (status === RuntimeLimitStatus.BLOCKED) {
    return info.overageStatus === "rejected" ? "overage" : baseType;
  }

  if (status === RuntimeLimitStatus.WARNING) {
    return overageRelevant ? "overage" : baseType;
  }

  return overageRelevant ? "overage" : baseType;
}

export function normalizeClaudeLimitSnapshot(
  input: NormalizeClaudeLimitSnapshotInput,
): RuntimeLimitSnapshot | null {
  const raw = asRecord(input.info);
  const info: ClaudeRateLimitInfo = {
    status: readString(raw.status) as ClaudeRateLimitStatus | undefined,
    resetsAt: readNumber(raw.resetsAt) ?? undefined,
    rateLimitType: readString(raw.rateLimitType) as ClaudeRateLimitType | undefined,
    utilization: readNumber(raw.utilization) ?? undefined,
    overageStatus: readString(raw.overageStatus) as ClaudeRateLimitStatus | undefined,
    overageResetsAt: readNumber(raw.overageResetsAt) ?? undefined,
    overageDisabledReason: readString(raw.overageDisabledReason) ?? undefined,
    isUsingOverage: readBoolean(raw.isUsingOverage) ?? undefined,
    surpassedThreshold: readNumber(raw.surpassedThreshold) ?? undefined,
  };

  const status = mapStatus(info);
  const primaryRateLimitType = resolvePrimaryRateLimitType(info, status);
  const scope = mapScope(primaryRateLimitType);
  const percentUsed = normalizeUtilizationPercent(info.utilization ?? null);
  const percentRemaining =
    percentUsed == null ? null : Math.max(0, Math.min(100, 100 - percentUsed));
  const resetAt =
    primaryRateLimitType === "overage"
      ? (normalizeTimestamp(info.overageResetsAt ?? null) ??
        normalizeTimestamp(info.resetsAt ?? null))
      : (normalizeTimestamp(info.resetsAt ?? null) ??
        normalizeTimestamp(info.overageResetsAt ?? null));

  const hasMeaningfulSignal =
    status !== RuntimeLimitStatus.UNKNOWN ||
    resetAt != null ||
    percentUsed != null ||
    primaryRateLimitType != null ||
    info.isUsingOverage === true;

  if (!hasMeaningfulSignal) {
    return null;
  }

  const window: RuntimeLimitWindow = {
    scope,
    name: primaryRateLimitType,
    percentUsed,
    percentRemaining,
    resetAt,
  };

  return {
    source: RuntimeLimitSource.SDK_EVENT,
    status,
    precision: RuntimeLimitPrecision.HEURISTIC,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: scope,
    resetAt,
    retryAfterSeconds: null,
    warningThreshold: null,
    windows: [window],
    providerMeta: {
      providerFamily: input.providerIdentity?.providerFamily ?? null,
      providerLabel: input.providerIdentity?.providerLabel ?? null,
      quotaSource: input.providerIdentity?.quotaSource ?? null,
      accountFingerprint: input.providerIdentity?.accountFingerprint ?? null,
      accountLabel: input.providerIdentity?.accountLabel ?? null,
      rateLimitType: primaryRateLimitType,
      status: info.status ?? null,
      overageStatus: info.overageStatus ?? null,
      isUsingOverage: info.isUsingOverage ?? null,
      surpassedThreshold: info.surpassedThreshold ?? null,
      overageDisabledReason: info.overageDisabledReason ?? null,
    },
  };
}
