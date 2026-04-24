import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "../../types.js";
import type { ClaudeProviderIdentity } from "./providerIdentity.js";

interface ZaiQuotaLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

interface FetchZaiClaudeQuotaSnapshotInput {
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  identity: ClaudeProviderIdentity;
  authToken: string;
  checkedAt?: string;
  logger?: ZaiQuotaLogger;
}

const WARNING_THRESHOLD = 10;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const ZAI_QUOTA_REQUEST_TIMEOUT_MS = 1_500;
const ZAI_USAGE_WINDOW_HOURS = 24;

type ZaiMonitorFetchKind = "quota" | "model_usage" | "tool_usage";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item != null)
    : [];
}

function normalizeTimestamp(value: unknown): string | null {
  const raw = readFiniteNumber(value);
  if (raw == null) return null;

  const targetMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    return null;
  }

  const date = new Date(targetMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeUsageBucketLabel(value: unknown): string | null {
  return readString(value);
}

function formatUsageWindowDateTime(date: Date): string {
  const pad = (target: number): string => String(target).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildUsageWindowSearchParams(now: Date = new Date()): URLSearchParams {
  const startDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    now.getHours(),
    0,
    0,
    0,
  );
  const endDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    59,
    59,
    999,
  );

  return new URLSearchParams({
    startTime: formatUsageWindowDateTime(startDate),
    endTime: formatUsageWindowDateTime(endDate),
  });
}

function toPercentRemaining(percentUsed: number | null): number | null {
  if (percentUsed == null) return null;
  return Math.max(0, Math.min(100, 100 - percentUsed));
}

function buildWindowFromLimit(limit: Record<string, unknown>): RuntimeLimitWindow | null {
  const limitType = readString(limit.type);
  const percentUsed = readFiniteNumber(limit.percentage);
  const percentRemaining = toPercentRemaining(percentUsed);
  const resetAt = normalizeTimestamp(limit.nextResetTime);
  const remaining = readFiniteNumber(limit.remaining);
  const used = readFiniteNumber(limit.currentValue);
  const total = readFiniteNumber(limit.usage);

  if (limitType === "TOKENS_LIMIT") {
    if (percentUsed == null && percentRemaining == null && resetAt == null) {
      return null;
    }

    return {
      scope: RuntimeLimitScope.TOKENS,
      name: "5h",
      percentUsed,
      percentRemaining,
      resetAt,
      warningThreshold: WARNING_THRESHOLD,
    };
  }

  if (limitType === "TIME_LIMIT") {
    if (
      percentUsed == null &&
      percentRemaining == null &&
      remaining == null &&
      used == null &&
      total == null &&
      resetAt == null
    ) {
      return null;
    }

    return {
      scope: RuntimeLimitScope.TOOL_USAGE,
      name: "MCP",
      used,
      remaining,
      limit: total,
      percentUsed,
      percentRemaining,
      resetAt,
      warningThreshold: WARNING_THRESHOLD,
    };
  }

  return null;
}

function resolveSnapshotStatus(windows: RuntimeLimitWindow[]): RuntimeLimitStatus {
  if (
    windows.some(
      (window) =>
        (typeof window.percentRemaining === "number" && window.percentRemaining <= 0) ||
        (typeof window.remaining === "number" && window.remaining <= 0),
    )
  ) {
    return RuntimeLimitStatus.BLOCKED;
  }

  if (
    windows.some(
      (window) =>
        (typeof window.percentRemaining === "number" &&
          window.percentRemaining <= WARNING_THRESHOLD) ||
        (typeof window.remaining === "number" &&
          typeof window.limit === "number" &&
          window.limit > 0 &&
          window.remaining / window.limit <= WARNING_THRESHOLD / 100),
    )
  ) {
    return RuntimeLimitStatus.WARNING;
  }

  if (windows.length > 0) {
    return RuntimeLimitStatus.OK;
  }

  return RuntimeLimitStatus.UNKNOWN;
}

function selectPrimaryQuotaWindow(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitWindow | null {
  if (windows.length === 0) return null;

  const score = (window: RuntimeLimitWindow): number => {
    if (typeof window.resetAt === "string") {
      const parsed = Date.parse(window.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };

  const matching = windows.filter((window) => {
    if (status === RuntimeLimitStatus.BLOCKED) {
      return (
        (typeof window.percentRemaining === "number" && window.percentRemaining <= 0) ||
        (typeof window.remaining === "number" && window.remaining <= 0)
      );
    }

    if (status === RuntimeLimitStatus.WARNING) {
      return (
        (typeof window.percentRemaining === "number" &&
          window.percentRemaining <= WARNING_THRESHOLD) ||
        (typeof window.remaining === "number" &&
          typeof window.limit === "number" &&
          window.limit > 0 &&
          window.remaining / window.limit <= WARNING_THRESHOLD / 100)
      );
    }

    return true;
  });

  const candidates = matching.length > 0 ? matching : windows;
  return candidates.reduce(
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

function buildMonitorHeaders(authToken: string): Record<string, string> {
  return {
    Authorization: authToken,
    "Accept-Language": "en-US,en",
    "Content-Type": "application/json",
  };
}

async function fetchZaiMonitorPayload(
  input: FetchZaiClaudeQuotaSnapshotInput,
  path: string,
  kind: ZaiMonitorFetchKind,
  options?: { includeUsageWindow?: boolean },
): Promise<Record<string, unknown> | null> {
  if (!input.identity.baseOrigin) {
    return null;
  }

  const url = new URL(path, input.identity.baseOrigin);
  if (options?.includeUsageWindow) {
    url.search = buildUsageWindowSearchParams().toString();
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), ZAI_QUOTA_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: buildMonitorHeaders(input.authToken),
      signal: abortController.signal,
    });
  } catch (error) {
    input.logger?.[kind === "quota" ? "warn" : "debug"]?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        baseOrigin: input.identity.baseOrigin,
        endpoint: url.pathname,
        timeoutMs: ZAI_QUOTA_REQUEST_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
      },
      kind === "quota"
        ? "Unable to refresh Z.AI coding quota snapshot from provider monitor endpoint"
        : "Unable to refresh optional Z.AI usage summary from provider monitor endpoint",
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    input.logger?.[kind === "quota" ? "warn" : "debug"]?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        baseOrigin: input.identity.baseOrigin,
        endpoint: url.pathname,
        status: response.status,
      },
      kind === "quota"
        ? "Unable to refresh Z.AI coding quota snapshot from provider monitor endpoint"
        : "Unable to refresh optional Z.AI usage summary from provider monitor endpoint",
    );
    return null;
  }

  const payload = asRecord(await response.json());
  return asRecord(payload?.data) ?? payload;
}

function normalizeZaiModelUsageSummary(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  const totalUsage = asRecord(payload.totalUsage);
  const modelSummaryList = readRecordArray(payload.modelSummaryList ?? totalUsage?.modelSummaryList)
    .map((entry) => {
      const modelName = readString(entry.modelName);
      if (!modelName) {
        return null;
      }

      return {
        modelName,
        totalTokens: readFiniteNumber(entry.totalTokens),
        sortOrder: readFiniteNumber(entry.sortOrder),
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        modelName: string;
        totalTokens: number | null;
        sortOrder: number | null;
      } => entry != null,
    );

  const sampledAt =
    normalizeUsageBucketLabel(Array.isArray(payload.x_time) ? payload.x_time.at(-1) : null) ?? null;
  const granularity = readString(payload.granularity);
  const totalModelCallCount = readFiniteNumber(totalUsage?.totalModelCallCount);
  const totalTokensUsage = readFiniteNumber(totalUsage?.totalTokensUsage);

  if (
    granularity == null &&
    sampledAt == null &&
    totalModelCallCount == null &&
    totalTokensUsage == null &&
    modelSummaryList.length === 0
  ) {
    return null;
  }

  return {
    granularity,
    sampledAt,
    totalModelCallCount,
    totalTokensUsage,
    topModels: modelSummaryList,
    windowHours: ZAI_USAGE_WINDOW_HOURS,
  };
}

function normalizeZaiToolSummaryEntry(
  entry: Record<string, unknown>,
): { toolName: string; totalCount: number | null } | null {
  const toolName =
    readString(entry.toolName) ??
    readString(entry.name) ??
    readString(entry.toolCode) ??
    readString(entry.modelCode);
  if (!toolName) {
    return null;
  }

  const totalCount =
    readFiniteNumber(entry.totalCount) ??
    readFiniteNumber(entry.totalUsage) ??
    readFiniteNumber(entry.count) ??
    readFiniteNumber(entry.usage);

  return { toolName, totalCount };
}

function normalizeZaiToolUsageSummary(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  const totalUsage = asRecord(payload.totalUsage);
  const toolSummaryList = readRecordArray(payload.toolSummaryList ?? totalUsage?.toolSummaryList)
    .map((entry) => normalizeZaiToolSummaryEntry(entry))
    .filter((entry): entry is { toolName: string; totalCount: number | null } => entry != null);

  const sampledAt =
    normalizeUsageBucketLabel(Array.isArray(payload.x_time) ? payload.x_time.at(-1) : null) ?? null;
  const granularity = readString(payload.granularity);
  const totalNetworkSearchCount =
    readFiniteNumber(totalUsage?.totalNetworkSearchCount) ??
    readFiniteNumber(payload.networkSearchCount);
  const totalWebReadMcpCount =
    readFiniteNumber(totalUsage?.totalWebReadMcpCount) ?? readFiniteNumber(payload.webReadMcpCount);
  const totalZreadMcpCount =
    readFiniteNumber(totalUsage?.totalZreadMcpCount) ?? readFiniteNumber(payload.zreadMcpCount);
  const totalSearchMcpCount = readFiniteNumber(totalUsage?.totalSearchMcpCount);

  if (
    granularity == null &&
    sampledAt == null &&
    totalNetworkSearchCount == null &&
    totalWebReadMcpCount == null &&
    totalZreadMcpCount == null &&
    totalSearchMcpCount == null &&
    toolSummaryList.length === 0
  ) {
    return null;
  }

  return {
    granularity,
    sampledAt,
    totalNetworkSearchCount,
    totalWebReadMcpCount,
    totalZreadMcpCount,
    totalSearchMcpCount,
    tools: toolSummaryList,
    windowHours: ZAI_USAGE_WINDOW_HOURS,
  };
}

export async function fetchZaiClaudeQuotaSnapshot(
  input: FetchZaiClaudeQuotaSnapshotInput,
): Promise<RuntimeLimitSnapshot | null> {
  if (input.identity.providerFamily !== "zai-glm-coding" || !input.identity.baseOrigin) {
    return null;
  }

  const [data, modelUsagePayload, toolUsagePayload] = await Promise.all([
    fetchZaiMonitorPayload(input, "/api/monitor/usage/quota/limit", "quota"),
    fetchZaiMonitorPayload(input, "/api/monitor/usage/model-usage", "model_usage", {
      includeUsageWindow: true,
    }),
    fetchZaiMonitorPayload(input, "/api/monitor/usage/tool-usage", "tool_usage", {
      includeUsageWindow: true,
    }),
  ]);

  if (!data) {
    return null;
  }

  const rawLimits = Array.isArray(data?.limits) ? data.limits : [];
  const windows = rawLimits
    .map((limit) => buildWindowFromLimit(asRecord(limit) ?? {}))
    .filter((window): window is RuntimeLimitWindow => window != null);

  if (windows.length === 0) {
    return null;
  }

  const status = resolveSnapshotStatus(windows);
  const primaryWindow = selectPrimaryQuotaWindow(windows, status);
  const resetAt = primaryWindow?.resetAt ?? null;
  const usageDetails =
    rawLimits.map((limit) => asRecord(limit)).find((limit) => Array.isArray(limit?.usageDetails))
      ?.usageDetails ?? null;
  const modelUsageSummary = normalizeZaiModelUsageSummary(modelUsagePayload);
  const toolUsageSummary = normalizeZaiToolUsageSummary(toolUsagePayload);

  const snapshot: RuntimeLimitSnapshot = {
    source: RuntimeLimitSource.PROVIDER_API,
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: primaryWindow?.scope ?? windows[0]?.scope ?? RuntimeLimitScope.TOKENS,
    resetAt,
    retryAfterSeconds: null,
    warningThreshold: WARNING_THRESHOLD,
    windows,
    providerMeta: {
      providerFamily: input.identity.providerFamily,
      providerLabel: input.identity.providerLabel,
      quotaSource: input.identity.quotaSource,
      accountFingerprint: input.identity.accountFingerprint,
      accountLabel: input.identity.accountLabel,
      planType: readString(data?.level),
      usageDetails,
      modelUsageSummary,
      toolUsageSummary,
    },
  };

  input.logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      status: snapshot.status,
      windowCount: snapshot.windows.length,
    },
    "Observed Z.AI coding quota snapshot from provider monitor endpoint",
  );

  return snapshot;
}
