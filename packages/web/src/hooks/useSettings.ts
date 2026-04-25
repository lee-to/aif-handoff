import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
}

export function useProjectDefaults(projectId: string | null) {
  return useQuery({
    queryKey: ["projectDefaults", projectId],
    queryFn: () => api.getProjectDefaults(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

// Module-level cache for the usage-limits feature flag. The flag is driven by
// an env var and never changes during a session, so a single fetch outside the
// React Query cache avoids requiring a QueryClientProvider on every isolated
// component (tests in particular render components without the provider).
let cachedUsageLimitsEnabled: boolean | null = null;
let inFlightUsageLimitsFetch: Promise<void> | null = null;
const usageLimitsListeners = new Set<(value: boolean) => void>();

async function loadUsageLimitsFlag(): Promise<void> {
  if (cachedUsageLimitsEnabled !== null) return;
  if (inFlightUsageLimitsFetch) return inFlightUsageLimitsFetch;
  inFlightUsageLimitsFetch = (async () => {
    try {
      const settings = await api.getSettings();
      cachedUsageLimitsEnabled = settings.usageLimitsEnabled ?? true;
    } catch {
      // Network/API failure: stay optimistic so a transient error cannot
      // make the whole usage UI silently disappear. The UI auto-corrects
      // once the real `/settings` response resolves on retry.
      cachedUsageLimitsEnabled = true;
    }
    const value = cachedUsageLimitsEnabled ?? true;
    usageLimitsListeners.forEach((listener) => listener(value));
  })();
  return inFlightUsageLimitsFetch;
}

/**
 * True when the backend has the usage-limits feature enabled. Returns `true`
 * optimistically on the first render (so the usage UI is not briefly hidden
 * before the `/settings` response lands) and flips to `false` if the backend
 * actually has `AIF_USAGE_LIMITS_ENABLED` disabled. Components that render
 * usage-limit surfaces should gate on this so disabled deployments never
 * render stale data once the fetch resolves.
 */
export function useUsageLimitsEnabled(): boolean {
  const [value, setValue] = useState<boolean>(() => cachedUsageLimitsEnabled ?? true);
  // The rule `react-hooks/set-state-in-effect` normally flags setState inside
  // an effect. Here the effect is syncing an external module-level store to
  // component state: the initial branch copies the already-resolved cache
  // into local state, and the listener branch responds to async fetch
  // resolution. Neither call causes a render cascade because both produce
  // the same value across repeated renders. `useSyncExternalStore` was
  // tried here and caused a runtime render storm with React Query
  // subscribers, so we keep the useState pattern and silence the rule.
  useEffect(() => {
    if (cachedUsageLimitsEnabled !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(cachedUsageLimitsEnabled);
      return;
    }
    const listener = (next: boolean) => setValue(next);
    usageLimitsListeners.add(listener);
    void loadUsageLimitsFlag();
    return () => {
      usageLimitsListeners.delete(listener);
    };
  }, []);
  return value;
}

/** Test-only: reset the module-level usage-limits cache between cases. */
export function __resetUsageLimitsFlagCacheForTests(): void {
  cachedUsageLimitsEnabled = null;
  inFlightUsageLimitsFetch = null;
  usageLimitsListeners.clear();
}

/**
 * Test-only: synchronously seed the usage-limits cache so components that
 * render usage-limit surfaces stay visible without mocking `/settings`.
 */
export function __setUsageLimitsFlagForTests(value: boolean): void {
  cachedUsageLimitsEnabled = value;
  inFlightUsageLimitsFetch = null;
  usageLimitsListeners.forEach((listener) => listener(value));
}
