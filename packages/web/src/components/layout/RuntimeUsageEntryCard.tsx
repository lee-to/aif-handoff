import { useState, type ReactNode } from "react";
import type {
  RuntimeLimitSnapshot,
  RuntimeLimitWindow,
  RuntimeProfileUsage,
} from "@aif/shared/browser";
import { Badge } from "@/components/ui/badge";
import { Collapsible } from "@/components/ui/collapsible";
import { getRuntimeLimitDisplay, runtimeLimitBadgeClassName } from "@/lib/runtimeLimits";
import {
  formatEntryHeading,
  readProviderMetaString,
  type RuntimeUsageEntry,
} from "./runtimeUsageDialogModel";

interface ZaiModelUsageItem {
  modelName: string;
  totalTokens: number | null;
}

interface ZaiModelUsageSummary {
  granularity: string | null;
  sampledAt: string | null;
  totalModelCallCount: number | null;
  totalTokensUsage: number | null;
  topModels: ZaiModelUsageItem[];
  windowHours: number | null;
}

interface ZaiToolUsageItem {
  toolName: string;
  totalCount: number | null;
}

interface ZaiToolUsageSummary {
  granularity: string | null;
  sampledAt: string | null;
  totalNetworkSearchCount: number | null;
  totalWebReadMcpCount: number | null;
  totalZreadMcpCount: number | null;
  totalSearchMcpCount: number | null;
  tools: ZaiToolUsageItem[];
  windowHours: number | null;
}

interface MetricBadgeValue {
  key: string;
  text: string;
}

interface UsageInsightsCardProps {
  title: string;
  updatedLabel: string | null;
  description: string;
  badges: MetricBadgeValue[];
  children: ReactNode;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

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

function formatCompactQuantity(value: number): string {
  return COMPACT_NUMBER_FORMAT.format(value);
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

function formatTimestampOrRaw(value: string | null | undefined): string | null {
  return (
    formatTimestamp(value) ?? (typeof value === "string" && value.trim().length > 0 ? value : null)
  );
}

function formatGranularity(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split(/[_\-\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toUpperCase())
    .join(" ");
}

function mapWindowName(name: string | null | undefined): string | null {
  switch (name) {
    case "five_hour":
      return "5h";
    case "seven_day":
      return "7d";
    case "seven_day_opus":
      return "7d Opus";
    case "seven_day_sonnet":
      return "7d Sonnet";
    case "overage":
      return "Overage";
    default:
      return typeof name === "string" && name.trim().length > 0 ? name.replace(/_/g, " ") : null;
  }
}

function scopeLabel(scope: RuntimeLimitWindow["scope"]): string {
  switch (scope) {
    case "requests":
      return "Requests";
    case "tokens":
      return "Tokens";
    case "time":
      return "Window";
    case "spend":
      return "Spend";
    case "turn_usage":
      return "Turn usage";
    case "model_usage":
      return "Model usage";
    case "tool_usage":
      return "Tool usage";
    default:
      return "Runtime quota";
  }
}

function windowLabel(window: RuntimeLimitWindow): string {
  return mapWindowName(window.name ?? null) ?? scopeLabel(window.scope);
}

function windowSummary(window: RuntimeLimitWindow): string {
  const percentRemaining = toFiniteNumber(window.percentRemaining);
  const percentUsed = toFiniteNumber(window.percentUsed);
  const remaining = toFiniteNumber(window.remaining);
  const limit = toFiniteNumber(window.limit);
  const used = toFiniteNumber(window.used);

  if (percentRemaining != null) {
    return `${formatPercent(percentRemaining)} remaining`;
  }
  if (remaining != null && limit != null) {
    return `${formatQuantity(remaining)} of ${formatQuantity(limit)} remaining`;
  }
  if (remaining != null) {
    return `${formatQuantity(remaining)} remaining`;
  }
  if (used != null && limit != null) {
    return `${formatQuantity(used)} of ${formatQuantity(limit)} used`;
  }
  if (percentUsed != null) {
    return `${formatPercent(percentUsed)} used`;
  }
  return "No detailed quota signal";
}

function windowResetText(
  window: RuntimeLimitWindow,
  snapshot: RuntimeLimitSnapshot | null,
): string | null {
  const resetLabel = formatTimestamp(window.resetAt ?? snapshot?.resetAt ?? null);
  if (resetLabel) {
    return `Resets ${resetLabel}`;
  }

  const retryAfterSeconds = window.retryAfterSeconds ?? snapshot?.retryAfterSeconds ?? null;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    return `Retry after ${Math.max(0, Math.round(retryAfterSeconds))}s`;
  }

  return null;
}

function readProviderMetaRecord(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const providerMeta = snapshot?.providerMeta;
  if (!providerMeta || typeof providerMeta !== "object") {
    return null;
  }

  const rawValue = (providerMeta as Record<string, unknown>)[key];
  return rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
    ? (rawValue as Record<string, unknown>)
    : null;
}

function readRecordString(record: Record<string, unknown> | null, key: string): string | null {
  const rawValue = record?.[key];
  return typeof rawValue === "string" && rawValue.trim().length > 0 ? rawValue.trim() : null;
}

function readRecordNumber(record: Record<string, unknown> | null, key: string): number | null {
  const rawValue = record?.[key];
  return typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : null;
}

function readRecordArray(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown>[] {
  const rawValue = record?.[key];
  return Array.isArray(rawValue)
    ? rawValue.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function readZaiModelUsageSummary(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): ZaiModelUsageSummary | null {
  const summary = readProviderMetaRecord(snapshot, "modelUsageSummary");
  if (!summary) {
    return null;
  }

  const topModels = readRecordArray(summary, "topModels")
    .map((item) => {
      const modelName = readRecordString(item, "modelName");
      if (!modelName) {
        return null;
      }
      return {
        modelName,
        totalTokens: readRecordNumber(item, "totalTokens"),
      };
    })
    .filter((item): item is ZaiModelUsageItem => item != null);

  return {
    granularity: readRecordString(summary, "granularity"),
    sampledAt: readRecordString(summary, "sampledAt"),
    totalModelCallCount: readRecordNumber(summary, "totalModelCallCount"),
    totalTokensUsage: readRecordNumber(summary, "totalTokensUsage"),
    topModels,
    windowHours: readRecordNumber(summary, "windowHours"),
  };
}

function readZaiToolUsageSummary(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): ZaiToolUsageSummary | null {
  const summary = readProviderMetaRecord(snapshot, "toolUsageSummary");
  if (!summary) {
    return null;
  }

  const tools = readRecordArray(summary, "tools")
    .map((item) => {
      const toolName = readRecordString(item, "toolName");
      if (!toolName) {
        return null;
      }
      return {
        toolName,
        totalCount: readRecordNumber(item, "totalCount"),
      };
    })
    .filter((item): item is ZaiToolUsageItem => item != null);

  return {
    granularity: readRecordString(summary, "granularity"),
    sampledAt: readRecordString(summary, "sampledAt"),
    totalNetworkSearchCount: readRecordNumber(summary, "totalNetworkSearchCount"),
    totalWebReadMcpCount: readRecordNumber(summary, "totalWebReadMcpCount"),
    totalZreadMcpCount: readRecordNumber(summary, "totalZreadMcpCount"),
    totalSearchMcpCount: readRecordNumber(summary, "totalSearchMcpCount"),
    tools,
    windowHours: readRecordNumber(summary, "windowHours"),
  };
}

function usageDetailRows(usage: RuntimeProfileUsage): Array<{ label: string; value: string }> {
  const rows = [
    { label: "Input", value: formatQuantity(usage.inputTokens) },
    { label: "Output", value: formatQuantity(usage.outputTokens) },
    { label: "Total", value: formatQuantity(usage.totalTokens) },
  ];

  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
    rows.push({
      label: "Cost",
      value: `$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`,
    });
  }

  return rows;
}

function usageSummaryBadges(summary: ZaiModelUsageSummary): MetricBadgeValue[] {
  const badges: MetricBadgeValue[] = [];

  if (summary.totalModelCallCount != null) {
    badges.push({
      key: "calls",
      text: `CALLS ${formatCompactQuantity(summary.totalModelCallCount)}`,
    });
  }
  if (summary.totalTokensUsage != null) {
    badges.push({
      key: "tokens",
      text: `TOKENS ${formatCompactQuantity(summary.totalTokensUsage)}`,
    });
  }
  if (summary.windowHours != null) {
    badges.push({ key: "window", text: `${summary.windowHours}H WINDOW` });
  }
  const granularity = formatGranularity(summary.granularity);
  if (granularity) {
    badges.push({ key: "granularity", text: granularity });
  }

  return badges;
}

function toolSummaryBadges(summary: ZaiToolUsageSummary): MetricBadgeValue[] {
  const badges: MetricBadgeValue[] = [];

  if (summary.totalNetworkSearchCount != null) {
    badges.push({
      key: "search",
      text: `SEARCH ${formatCompactQuantity(summary.totalNetworkSearchCount)}`,
    });
  }
  if (summary.totalWebReadMcpCount != null) {
    badges.push({
      key: "web-read",
      text: `WEB READ ${formatCompactQuantity(summary.totalWebReadMcpCount)}`,
    });
  }
  if (summary.totalZreadMcpCount != null) {
    badges.push({
      key: "zread",
      text: `ZREAD ${formatCompactQuantity(summary.totalZreadMcpCount)}`,
    });
  }
  if (summary.windowHours != null) {
    badges.push({ key: "window", text: `${summary.windowHours}H WINDOW` });
  }
  const granularity = formatGranularity(summary.granularity);
  if (granularity) {
    badges.push({ key: "granularity", text: granularity });
  }

  return badges;
}

function UsageInsightsCard({
  title,
  updatedLabel,
  description,
  badges,
  children,
}: UsageInsightsCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border/70 bg-card/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <span className="text-[11px] text-muted-foreground">
          {updatedLabel ? `Sampled ${updatedLabel}` : "No sample time"}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{description}</p>
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        trigger={expanded ? "Hide details" : "Show details"}
        className="mt-3 space-y-3"
      >
        {badges.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Badge
                key={`${title}:${badge.key}`}
                size="sm"
                className="border-border bg-background/60 text-foreground"
              >
                {badge.text}
              </Badge>
            ))}
          </div>
        ) : null}
        {children}
      </Collapsible>
    </div>
  );
}

export function RuntimeUsageEntryCard({ entry }: { entry: RuntimeUsageEntry }) {
  const limitDisplay = getRuntimeLimitDisplay(entry.snapshot, {
    checkedAt: entry.snapshotUpdatedAt,
  });
  const limitPoolId = readProviderMetaString(entry.snapshot, "limitId");
  const quotaUpdatedLabel = formatTimestamp(entry.snapshotUpdatedAt);
  const usageUpdatedLabel = formatTimestamp(entry.lastUsageAt);
  const windowList = entry.snapshot?.windows ?? [];
  const usageRows = entry.lastUsage ? usageDetailRows(entry.lastUsage) : [];
  const headingLabel = formatEntryHeading(entry);
  const modelUsageSummary = readZaiModelUsageSummary(entry.snapshot);
  const toolUsageSummary = readZaiToolUsageSummary(entry.snapshot);
  const modelUsageBadges = modelUsageSummary ? usageSummaryBadges(modelUsageSummary) : [];
  const toolUsageBadges = toolUsageSummary ? toolSummaryBadges(toolUsageSummary) : [];
  const modelUsageUpdatedLabel = formatTimestampOrRaw(modelUsageSummary?.sampledAt);
  const toolUsageUpdatedLabel = formatTimestampOrRaw(toolUsageSummary?.sampledAt);

  return (
    <div key={entry.key} className="border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{headingLabel}</span>
            {limitDisplay ? (
              <Badge size="sm" className={runtimeLimitBadgeClassName(limitDisplay.tone)}>
                {limitDisplay.label.toUpperCase()}
              </Badge>
            ) : (
              <Badge size="sm" className="border-border bg-secondary/60 text-muted-foreground">
                {entry.lastUsage ? "USAGE ONLY" : "NO SIGNAL"}
              </Badge>
            )}
          </div>
          <div className="mt-1.5 break-words text-sm font-medium text-foreground/90">
            {entry.profileNames.length > 1 ? "Profiles" : "Profile"}:{" "}
            {entry.profileNames.join(", ")}
          </div>
          {limitPoolId ? (
            <div className="mt-1 text-xs text-muted-foreground">Limit pool: {limitPoolId}</div>
          ) : null}
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>{quotaUpdatedLabel ? `Quota ${quotaUpdatedLabel}` : "Quota not updated yet"}</div>
          <div>{usageUpdatedLabel ? `Usage ${usageUpdatedLabel}` : "Usage not updated yet"}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="border border-border/70 bg-card/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Quota
            </p>
            <span className="text-[11px] text-muted-foreground">
              {quotaUpdatedLabel ? `Updated ${quotaUpdatedLabel}` : "No update yet"}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {limitDisplay?.summary ??
              "No live quota window reported for this runtime/transport yet."}
          </p>

          {windowList.length > 0 ? (
            <div className="mt-3 space-y-1">
              {windowList.map((window, index) => {
                const resetText = windowResetText(window, entry.snapshot);
                return (
                  <div
                    key={`${entry.key}:${window.scope}:${window.name ?? index}`}
                    className="flex flex-wrap items-start justify-between gap-2 border border-border/70 bg-background/50 px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{windowLabel(window)}</p>
                      <p className="text-[11px] text-muted-foreground">{windowSummary(window)}</p>
                    </div>
                    <div className="text-right text-[11px] text-muted-foreground">
                      {resetText ?? "No reset time reported"}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 border border-border/70 bg-background/50 px-2 py-1.5 text-[11px] text-muted-foreground">
              Provider did not expose per-window quota details for this runtime.
            </div>
          )}
        </div>

        <div className="border border-border/70 bg-card/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last Usage
            </p>
            <span className="text-[11px] text-muted-foreground">
              {usageUpdatedLabel ? `Updated ${usageUpdatedLabel}` : "No update yet"}
            </span>
          </div>

          {entry.lastUsage ? (
            <div className="mt-3 grid gap-1 sm:grid-cols-2">
              {usageRows.map((row) => (
                <div
                  key={`${entry.key}:usage:${row.label}`}
                  className="border border-border/70 bg-background/50 px-2 py-1.5"
                >
                  <p className="text-[11px] text-muted-foreground">{row.label}</p>
                  <p className="text-sm font-medium">{row.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 border border-border/70 bg-background/50 px-2 py-1.5 text-[11px] text-muted-foreground">
              No recorded usage for this runtime profile yet.
            </div>
          )}
        </div>
      </div>

      {modelUsageSummary || toolUsageSummary ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {modelUsageSummary ? (
            <UsageInsightsCard
              title="Recent Model Usage"
              updatedLabel={modelUsageUpdatedLabel}
              description="Recent GLM model traffic from the provider monitor endpoint."
              badges={modelUsageBadges}
            >
              {modelUsageSummary.topModels.length > 0 ? (
                <div className="space-y-1">
                  {modelUsageSummary.topModels.map((item, index) => (
                    <div
                      key={`${entry.key}:model-summary:${item.modelName}:${index}`}
                      className="flex flex-wrap items-start justify-between gap-2 border border-border/70 bg-background/50 px-2 py-1.5"
                    >
                      <p className="text-xs font-medium">{item.modelName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {item.totalTokens != null
                          ? `${formatQuantity(item.totalTokens)} tokens`
                          : "No token total"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border border-border/70 bg-background/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                  No model-level breakdown returned for this usage window.
                </div>
              )}
            </UsageInsightsCard>
          ) : null}

          {toolUsageSummary ? (
            <UsageInsightsCard
              title="Recent Tool Usage"
              updatedLabel={toolUsageUpdatedLabel}
              description="Recent GLM MCP and tool activity from the provider monitor endpoint."
              badges={toolUsageBadges}
            >
              {toolUsageSummary.tools.length > 0 ? (
                <div className="space-y-1">
                  {toolUsageSummary.tools.map((item, index) => (
                    <div
                      key={`${entry.key}:tool-summary:${item.toolName}:${index}`}
                      className="flex flex-wrap items-start justify-between gap-2 border border-border/70 bg-background/50 px-2 py-1.5"
                    >
                      <p className="text-xs font-medium">{item.toolName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {item.totalCount != null
                          ? `${formatQuantity(item.totalCount)} calls`
                          : "No usage total"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border border-border/70 bg-background/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                  No tool-level breakdown returned for this usage window.
                </div>
              )}
            </UsageInsightsCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
