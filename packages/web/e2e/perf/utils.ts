import type { Page, Request, Response } from "@playwright/test";

export interface NavigationTimingMetrics {
  dnsMs: number;
  connectMs: number;
  ttfbMs: number;
  domContentLoadedMs: number;
  loadMs: number;
}

export interface WebVitals {
  fcpMs: number | null;
  lcpMs: number | null;
}

export interface NetworkSample {
  url: string;
  status: number;
  durationMs: number;
  fromCache: boolean;
  resourceType: string;
}

/** Capture browser Navigation Timing entries for the current document. */
export async function readNavigationTiming(page: Page): Promise<NavigationTimingMetrics> {
  return await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!entry) {
      return {
        dnsMs: 0,
        connectMs: 0,
        ttfbMs: 0,
        domContentLoadedMs: 0,
        loadMs: 0,
      };
    }
    return {
      dnsMs: Math.max(0, entry.domainLookupEnd - entry.domainLookupStart),
      connectMs: Math.max(0, entry.connectEnd - entry.connectStart),
      ttfbMs: Math.max(0, entry.responseStart - entry.requestStart),
      domContentLoadedMs: Math.max(0, entry.domContentLoadedEventEnd - entry.startTime),
      loadMs: Math.max(0, entry.loadEventEnd - entry.startTime),
    };
  });
}

/**
 * Read FCP (first-contentful-paint) and the current largest-contentful-paint
 * observed by the browser. LCP is finalized on page hide in practice; for
 * synthetic perf we snapshot the last-known value after the page has settled.
 */
export async function readWebVitals(page: Page): Promise<WebVitals> {
  return await page.evaluate(
    () =>
      new Promise<WebVitals>((resolve) => {
        const fcpEntry = performance
          .getEntriesByType("paint")
          .find((entry) => entry.name === "first-contentful-paint");
        let lcpMs: number | null = null;
        try {
          const observer = new PerformanceObserver((list) => {
            const last = list.getEntries().at(-1);
            if (last) lcpMs = last.startTime;
          });
          observer.observe({ type: "largest-contentful-paint", buffered: true });
          setTimeout(() => {
            observer.disconnect();
            resolve({ fcpMs: fcpEntry?.startTime ?? null, lcpMs });
          }, 250);
        } catch {
          resolve({ fcpMs: fcpEntry?.startTime ?? null, lcpMs: null });
        }
      }),
  );
}

/**
 * Attach network listeners that record request/response durations for URLs
 * matching `predicate`. Call the returned `stop()` to detach and collect.
 */
export function recordNetwork(
  page: Page,
  predicate: (url: string) => boolean,
): { stop: () => NetworkSample[] } {
  const starts = new Map<Request, number>();
  const samples: NetworkSample[] = [];

  const onRequest = (request: Request) => {
    if (predicate(request.url())) {
      starts.set(request, Date.now());
    }
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (!predicate(request.url())) return;
    const startedAt = starts.get(request) ?? Date.now();
    starts.delete(request);
    samples.push({
      url: request.url(),
      status: response.status(),
      durationMs: Date.now() - startedAt,
      fromCache: response.fromServiceWorker() || response.fromCache?.() === true,
      resourceType: request.resourceType(),
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    stop(): NetworkSample[] {
      page.off("request", onRequest);
      page.off("response", onResponse);
      return samples.slice();
    },
  };
}

/**
 * Budgets enforced by every perf spec. Tune these after a few runs on the
 * target hardware so that regressions (not natural variance) trigger failures.
 */
// Budgets are calibrated for the full dev stack running (api + web + agent
// poller) — the agent's 2s tick adds contention on shared caches, so cold
// numbers here are noticeably higher than a curl-against-idle-server baseline.
// Tune after a handful of local runs; they should catch 10× regressions
// (the original "v13 schema miss" bug pushed cold /runtime-profiles to ~14s),
// not natural variance.
export const PERF_BUDGETS = {
  dashboardLcpMs: 3_000,
  dashboardDomReadyMs: 4_000,
  runtimeProfilesColdMs: 10_000,
  runtimeProfilesWarmMs: 250,
  chatSessionsColdMs: 6_000,
  chatSessionsWarmMs: 1_500,
} as const;
