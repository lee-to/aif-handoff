import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, readNavigationTiming, readWebVitals, recordNetwork } from "./utils";

// This spec exercises the cold dashboard render: open `/`, wait for the projects
// overview (or its empty state), then snapshot timing + network. "Cold" here means the
// browser has no HTTP cache for bundles — the API still uses its server-side
// cache, so early runs right after starting dev will hit worst-case latencies.
test.describe("dashboard cold load", () => {
  test("renders projects overview within LCP/DOM-ready budgets", async ({ page, context }) => {
    await context.clearCookies();
    const network = recordNetwork(page, (url) => url.includes("localhost:3009"));

    const projectsResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/projects" && response.request().method() === "GET",
    );
    const nav = page.goto("/", { waitUntil: "domcontentloaded" });
    const response = await nav;
    expect(response?.status() ?? 500).toBeLessThan(400);

    const projects = await projectsResponse;
    expect(projects.ok()).toBeTruthy();
    const rows = (await projects.json()) as Array<{ id: string }>;
    await expect(
      page.getByText(rows.length > 0 ? "Projects overview" : "No projects yet", { exact: true }),
    ).toBeVisible();

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
