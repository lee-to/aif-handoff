import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, recordNetwork } from "./utils";

// Measures the `/runtime-profiles` request from inside the browser: this is
// the real user path through fetch → React Query → render, not a raw curl.
// We hit the endpoint twice: first call covers cold caches (server-side scan
// of ~/.codex/sessions); second call should hit the per-endpoint memory cache.
test.describe("runtime-profiles endpoint timing", () => {
  test("cold and warm reads stay under their budgets", async ({ page, request }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const network = recordNetwork(page, (url) => url.includes("/runtime-profiles"));

    // Cold call from inside the page so cookies/origin match any session the
    // app is relying on. Fire-and-wait, not page-triggered, so we isolate the
    // endpoint cost from React render work.
    // Go through the Vite proxy (same origin) so there is no CORS or cookie
    // drift — this mirrors how the real app talks to the API in dev.
    const coldStart = Date.now();
    const coldResponse = await page.evaluate(async () => {
      const started = performance.now();
      const res = await fetch("/runtime-profiles?includeGlobal=true", {
        credentials: "include",
      });
      return { status: res.status, ms: performance.now() - started };
    });
    const coldTotalMs = Date.now() - coldStart;

    const warmResponse = await page.evaluate(async () => {
      const started = performance.now();
      const res = await fetch("/runtime-profiles?includeGlobal=true", {
        credentials: "include",
      });
      return { status: res.status, ms: performance.now() - started };
    });

    const samples = network.stop();

    // eslint-disable-next-line no-console
    console.log("[perf] runtime-profiles:", {
      coldMs: coldResponse.ms,
      warmMs: warmResponse.ms,
      coldTotalMs,
      samples: samples.map((s) => ({ durationMs: s.durationMs, status: s.status })),
    });

    expect(coldResponse.status).toBe(200);
    expect(warmResponse.status).toBe(200);
    expect(coldResponse.ms).toBeLessThan(PERF_BUDGETS.runtimeProfilesColdMs);
    expect(warmResponse.ms).toBeLessThan(PERF_BUDGETS.runtimeProfilesWarmMs);

    // Baseline from the node-side request API hits the API directly (no proxy)
    // so that a broken Vite dev proxy surfaces as a diff between the two.
    const baseline = await request.get("http://localhost:3009/runtime-profiles?includeGlobal=true");
    expect(baseline.ok()).toBeTruthy();
  });
});
