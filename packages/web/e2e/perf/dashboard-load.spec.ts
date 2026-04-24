import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, readNavigationTiming, readWebVitals, recordNetwork } from "./utils";

// This spec exercises the cold dashboard render: open `/`, wait for the kanban
// columns to be present, then snapshot timing + network. "Cold" here means the
// browser has no HTTP cache for bundles — the API still uses its server-side
// cache, so early runs right after starting dev will hit worst-case latencies.
test.describe("dashboard cold load", () => {
  test("renders kanban shell within LCP/DOM-ready budgets", async ({ page, context }) => {
    await context.clearCookies();
    const network = recordNetwork(page, (url) => url.includes("localhost:3009"));

    const nav = page.goto("/", { waitUntil: "domcontentloaded" });
    const response = await nav;
    expect(response?.status() ?? 500).toBeLessThan(400);

    // Wait until app shell paints the first kanban column header. If the app
    // renames the column label, update this locator — the goal is to anchor on
    // something that only exists once the board has real data rendered.
    await page.waitForSelector("text=/Backlog|Planning|Implementing/i", { timeout: 30_000 });

    const timing = await readNavigationTiming(page);
    const vitals = await readWebVitals(page);
    const apiCalls = network.stop();

    // eslint-disable-next-line no-console
    console.log("[perf] dashboard timing:", {
      nav: timing,
      vitals,
      apiCalls: apiCalls.map(({ url, durationMs, status }) => ({
        url: url.replace("http://localhost:3009", ""),
        durationMs,
        status,
      })),
    });

    expect(timing.domContentLoadedMs).toBeLessThan(PERF_BUDGETS.dashboardDomReadyMs);
    if (vitals.lcpMs != null) {
      expect(vitals.lcpMs).toBeLessThan(PERF_BUDGETS.dashboardLcpMs);
    }
  });
});
