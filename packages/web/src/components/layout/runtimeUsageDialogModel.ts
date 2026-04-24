import type {
  RuntimeLimitSnapshot,
  RuntimeProfile,
  RuntimeProfileUsage,
} from "@aif/shared/browser";

export interface RuntimeUsageEntry {
  key: string;
  runtimeId: string;
  providerId: string;
  transports: string[];
  baseUrl: string | null;
  defaultModels: string[];
  profileNames: string[];
  snapshot: RuntimeLimitSnapshot | null;
  snapshotUpdatedAt: string | null;
  lastUsage: RuntimeProfileUsage | null;
  lastUsageAt: string | null;
}

function formatPlanLabel(value: string | null): string | null {
  if (!value) return null;
  return value
    .split(/[_\-\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeIdentityValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function transportSortRank(value: string): number {
  switch (value) {
    case "sdk":
      return 0;
    case "cli":
      return 1;
    case "api":
      return 2;
    default:
      return 99;
  }
}

function latestLimitUpdatedAt(profile: RuntimeProfile): string | null {
  return profile.runtimeLimitUpdatedAt ?? profile.runtimeLimitSnapshot?.checkedAt ?? null;
}

function latestUsageUpdatedAt(profile: RuntimeProfile): string | null {
  return profile.lastUsageAt ?? null;
}

function updatedAtMs(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function readProviderMetaString(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  key: string,
): string | null {
  const providerMeta = snapshot?.providerMeta;
  if (!providerMeta || typeof providerMeta !== "object") {
    return null;
  }

  const rawValue = (providerMeta as Record<string, unknown>)[key];
  return typeof rawValue === "string" && rawValue.trim().length > 0 ? rawValue.trim() : null;
}

function parseUrlSafe(value: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function formatHostLabel(hostname: string | null): string {
  if (!hostname) return "Anthropic-compatible";
  return hostname
    .replace(/^www\./, "")
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(".");
}

function deriveClaudeProviderLabel(entry: RuntimeUsageEntry): string | null {
  const parsedBaseUrl = parseUrlSafe(entry.baseUrl);
  const hostname = parsedBaseUrl?.hostname.toLowerCase() ?? null;
  const pathname = parsedBaseUrl?.pathname.replace(/\/+$/, "").toLowerCase() ?? "";

  if (
    hostname === "api.z.ai" ||
    hostname === "open.bigmodel.cn" ||
    hostname === "dev.bigmodel.cn"
  ) {
    return "Z.AI GLM Coding Plan";
  }

  if (hostname?.includes("coding.dashscope.aliyuncs.com") && pathname.includes("/apps/anthropic")) {
    return "Alibaba Coding Plan";
  }

  if (hostname === "api.anthropic.com" || hostname?.endsWith(".anthropic.com")) {
    return "Anthropic";
  }

  if (entry.defaultModels.some((model) => /^glm[-_]/i.test(model))) {
    return "GLM-compatible";
  }

  return hostname ? formatHostLabel(hostname) : null;
}

function resolveEntryProviderLabel(entry: RuntimeUsageEntry): string | null {
  const snapshotLabel = readProviderMetaString(entry.snapshot, "providerLabel");
  if (snapshotLabel) {
    return snapshotLabel;
  }

  if (entry.runtimeId === "claude") {
    return deriveClaudeProviderLabel(entry);
  }

  return null;
}

function appendUnique(target: string[], value: string | null | undefined): void {
  if (!value) {
    return;
  }
  if (!target.includes(value)) {
    target.push(value);
  }
}

function identityGroupKey(profile: RuntimeProfile): string {
  const snapshot = profile.runtimeLimitSnapshot ?? null;
  const accountId = readProviderMetaString(snapshot, "accountId");
  const limitId = readProviderMetaString(snapshot, "limitId");
  const isLocalCodexProfile =
    profile.runtimeId === "codex" && (profile.transport === "sdk" || profile.transport === "cli");
  if (accountId && limitId) {
    return `${profile.runtimeId}|${profile.providerId}|account|${accountId}|limit|${limitId}`;
  }
  if (accountId && isLocalCodexProfile) {
    const modelKey =
      normalizeIdentityValue(profile.defaultModel) ??
      normalizeIdentityValue(profile.name) ??
      profile.id;
    return `${profile.runtimeId}|${profile.providerId}|account|${accountId}|model|${modelKey}`;
  }
  if (accountId) {
    return `${profile.runtimeId}|${profile.providerId}|account|${accountId}`;
  }

  const accountFingerprint = readProviderMetaString(snapshot, "accountFingerprint");
  if (accountFingerprint) {
    const providerFamily = readProviderMetaString(snapshot, "providerFamily") ?? "default";
    return `${profile.runtimeId}|${profile.providerId}|account-fingerprint|${providerFamily}|${accountFingerprint}`;
  }

  const isLocalAccountRuntime =
    (profile.runtimeId === "codex" || profile.runtimeId === "claude") &&
    (profile.transport === "sdk" || profile.transport === "cli");
  if (isLocalAccountRuntime) {
    const providerFamily = readProviderMetaString(snapshot, "providerFamily") ?? "default";
    return `${profile.runtimeId}|${profile.providerId}|local-account|${providerFamily}|${profile.baseUrl ?? "default"}`;
  }

  return `profile|${profile.id}`;
}

function isLocalAccountEntry(entry: RuntimeUsageEntry): boolean {
  return (
    (entry.runtimeId === "codex" || entry.runtimeId === "claude") &&
    entry.transports.every((transport) => transport === "sdk" || transport === "cli")
  );
}

function formatTransportSummary(entry: RuntimeUsageEntry): string | null {
  if (entry.transports.length === 0) {
    return null;
  }

  const ordered = [...entry.transports].sort((left, right) => {
    const rankDiff = transportSortRank(left) - transportSortRank(right);
    return rankDiff !== 0 ? rankDiff : left.localeCompare(right);
  });

  if (isLocalAccountEntry(entry)) {
    return ordered.join("/");
  }

  return ordered.map((transport) => transport.toUpperCase()).join("/");
}

export function formatEntryHeading(entry: RuntimeUsageEntry): string {
  const accountLabel =
    readProviderMetaString(entry.snapshot, "accountName") ??
    readProviderMetaString(entry.snapshot, "accountEmail") ??
    readProviderMetaString(entry.snapshot, "accountLabel");
  const providerLabel = resolveEntryProviderLabel(entry);
  const planLabel = formatPlanLabel(readProviderMetaString(entry.snapshot, "planType"));
  const transportLabel = formatTransportSummary(entry);
  const prefixLabel =
    accountLabel ??
    (entry.runtimeId === "claude" || isLocalAccountEntry(entry) ? providerLabel : null);

  const parts = [
    prefixLabel,
    entry.runtimeId === "claude" || isLocalAccountEntry(entry) ? planLabel : null,
    `${entry.runtimeId}/${entry.providerId}`,
    transportLabel,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return parts.join(" ");
}

export function buildRuntimeUsageEntries(profiles: RuntimeProfile[]): RuntimeUsageEntry[] {
  const grouped = new Map<string, RuntimeUsageEntry>();

  for (const profile of profiles) {
    if (!profile.enabled) continue;

    const key = identityGroupKey(profile);
    const profileLimitUpdatedAt = latestLimitUpdatedAt(profile);
    const profileUsageUpdatedAt = latestUsageUpdatedAt(profile);
    const existing = grouped.get(key);

    if (!existing) {
      const transports = profile.transport ? [profile.transport] : [];
      const defaultModels = profile.defaultModel ? [profile.defaultModel] : [];
      grouped.set(key, {
        key,
        runtimeId: profile.runtimeId,
        providerId: profile.providerId,
        transports,
        baseUrl: profile.baseUrl ?? null,
        defaultModels,
        profileNames: [profile.name],
        snapshot: profile.runtimeLimitSnapshot ?? null,
        snapshotUpdatedAt: profileLimitUpdatedAt,
        lastUsage: profile.lastUsage ?? null,
        lastUsageAt: profileUsageUpdatedAt,
      });
      continue;
    }

    if (!existing.profileNames.includes(profile.name)) {
      existing.profileNames.push(profile.name);
    }
    appendUnique(existing.transports, profile.transport ?? null);
    appendUnique(existing.defaultModels, profile.defaultModel ?? null);

    if (updatedAtMs(profileLimitUpdatedAt) > updatedAtMs(existing.snapshotUpdatedAt)) {
      existing.snapshot = profile.runtimeLimitSnapshot ?? null;
      existing.snapshotUpdatedAt = profileLimitUpdatedAt;
      existing.baseUrl = profile.baseUrl ?? null;
    }

    if (updatedAtMs(profileUsageUpdatedAt) > updatedAtMs(existing.lastUsageAt)) {
      existing.lastUsage = profile.lastUsage ?? null;
      existing.lastUsageAt = profileUsageUpdatedAt;
      existing.baseUrl = profile.baseUrl ?? null;
    }
  }

  const entries = Array.from(grouped.values());
  for (const entry of entries) {
    entry.transports.sort((left, right) => {
      const rankDiff = transportSortRank(left) - transportSortRank(right);
      return rankDiff !== 0 ? rankDiff : left.localeCompare(right);
    });
    entry.defaultModels.sort((left, right) => left.localeCompare(right));
    entry.profileNames.sort((left, right) => left.localeCompare(right));
  }

  return entries.sort((left, right) => {
    return `${formatEntryHeading(left)}|${left.profileNames.join(",")}`.localeCompare(
      `${formatEntryHeading(right)}|${right.profileNames.join(",")}`,
    );
  });
}
