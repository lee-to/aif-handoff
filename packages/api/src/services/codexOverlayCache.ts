import { listCodexLimitHeadsForOverlay } from "@aif/data";
import { normalizeCodexProjectPath, selectPreferredCodexLimitSnapshot } from "@aif/runtime";
import type { RuntimeLimitSnapshot } from "@aif/shared";

const DEFAULT_OVERLAY_CACHE_TTL_MS = 5_000;
const OVERLAY_QUERY_LIMIT = 50;

interface CodexOverlayCacheEntry {
  value: RuntimeLimitSnapshot | null;
  generation: number;
  expiresAt: number;
}

const codexOverlayCache = new Map<string, CodexOverlayCacheEntry>();
let currentGeneration = 0;

function cacheKey(input: {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId?: string | null;
  model?: string | null;
}): string {
  return [
    input.accountFingerprint,
    normalizeCodexProjectPath(input.projectRoot) ?? "__global__",
    input.limitId?.trim() || "__any_limit__",
    input.model?.trim() || "__any_model__",
  ].join(":");
}

export function resolveCachedCodexOverlaySnapshot(
  input: {
    accountFingerprint: string;
    projectRoot?: string | null;
    preferredLimitId?: string | null;
    model?: string | null;
  },
  options: { ttlMs?: number } = {},
): RuntimeLimitSnapshot | null {
  const key = cacheKey({
    accountFingerprint: input.accountFingerprint,
    projectRoot: input.projectRoot,
    limitId: input.preferredLimitId ?? null,
    model: input.model ?? null,
  });
  const now = Date.now();
  const cached = codexOverlayCache.get(key);
  if (cached && cached.generation === currentGeneration && cached.expiresAt > now) {
    return cached.value;
  }

  const rows = listCodexLimitHeadsForOverlay({
    accountFingerprint: input.accountFingerprint,
    projectRoot: input.projectRoot ?? null,
    includeGlobalFallback: true,
    limit: OVERLAY_QUERY_LIMIT,
  });
  const snapshots = rows
    .map((row) => row.snapshot)
    .filter((snapshot): snapshot is RuntimeLimitSnapshot => Boolean(snapshot));
  const value = selectPreferredCodexLimitSnapshot({
    model: input.model ?? null,
    snapshots,
    preferredLimitId: input.preferredLimitId ?? null,
  });

  codexOverlayCache.set(key, {
    value,
    generation: currentGeneration,
    expiresAt: now + (options.ttlMs ?? DEFAULT_OVERLAY_CACHE_TTL_MS),
  });
  return value;
}

export function invalidateCodexOverlayCache(): number {
  currentGeneration += 1;
  codexOverlayCache.clear();
  return currentGeneration;
}

export function clearCodexOverlayCache(): void {
  currentGeneration = 0;
  codexOverlayCache.clear();
}
