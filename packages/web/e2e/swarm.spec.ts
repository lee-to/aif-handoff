import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const snapshot = JSON.parse(
  readFileSync(new URL("../../../docs/swarm-v1.snapshot.json", import.meta.url), "utf8"),
);

for (const theme of ["light", "dark"] as const) {
  test(`Swarm control plane shows evidence and stale state in ${theme} theme`, async ({
    page,
  }, info) => {
    let offline = false;
    let commands = 0;
    await page.addInitScript((value) => {
      localStorage.setItem("aif-theme", value);
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        if (String(input).includes("/swarm/runs/run-1/events/stream")) {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
              options?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return originalFetch(input, options);
      };
    }, theme);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/api/, "");
      if (path === "/auth/session")
        return route.fulfill({
          json: {
            participantsModeEnabled: false,
            authenticated: true,
            participant: null,
            csrfToken: null,
            expiresAt: null,
          },
        });
      if (path === "/projects")
        return route.fulfill({
          json: [
            {
              id: "project-1",
              name: "Swarm project",
              rootPath: "/tmp/swarm-project",
              createdAt: snapshot.run.created_at,
              updatedAt: snapshot.run.updated_at,
            },
          ],
        });
      if (path === "/tasks") return route.fulfill({ json: [] });
      if (path === "/settings")
        return route.fulfill({
          json: {
            useSubagents: false,
            usageLimitsEnabled: false,
            warmupEnabled: false,
            runtimeReadiness: {},
            runtimeDefaults: { app: {} },
          },
        });
      if (path === "/swarm/connection")
        return route.fulfill({
          json: { enabled: true, projectId: "project-1", role: "owner", schemaVersion: 1 },
        });
      if (path === "/swarm/runs" && request.method() === "POST") {
        expect(request.postDataJSON()).toMatchObject({
          goal: "Wire protocol check",
          acceptance_criteria: ["Tests pass"],
          agent_limit: 2,
          budget_tokens: 100000,
          provider: "codex",
          checks: [["npm", "test"]],
        });
        return route.fulfill({ status: 202, json: { run_id: "run-1" } });
      }
      if (path === "/swarm/runs")
        return route.fulfill({ json: { schema_version: 1, runs: [snapshot.run] } });
      if (path === "/swarm/runs/run-1")
        return route.fulfill({
          status: offline ? 503 : 200,
          json: offline ? { code: "swarm_unavailable" } : snapshot,
        });
      if (path === "/swarm/runs/run-1/events")
        return route.fulfill({ json: { schema_version: 1, events: [] } });
      if (path === "/swarm/runs/run-1/events/stream")
        return route.fulfill({ contentType: "text/event-stream", body: ": heartbeat\n\n" });
      if (path === "/swarm/runs/run-1/pause") {
        commands++;
        return route.fulfill({
          status: 202,
          json: {
            schema_version: 1,
            command_id: request.postDataJSON().command_id,
            run_id: "run-1",
            accepted: true,
          },
        });
      }
      return route.continue();
    });
    await page.goto("/project/project-1");
    await page.getByRole("tab", { name: "Swarm", exact: true }).click();
    await page.getByRole("button", { name: "New Swarm run", exact: true }).click();
    await page.getByLabel("Goal", { exact: true }).fill("Wire protocol check");
    await page.getByLabel(/Acceptance criteria/).fill("Tests pass");
    await page.getByLabel(/Verification checks/).fill('[["npm", "test"]]');
    await page.getByLabel("Agent limit (all roles)").fill("2");
    await page.getByLabel("Token budget").fill("100000");
    await page.screenshot({ path: info.outputPath(`swarm-create-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Start run", exact: true }).click();
    await expect(page.getByText("Global acceptance criteria")).toBeVisible();
    await expect(page.getByRole("button", { name: "Instruct Lead", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(commands).toBe(0);
    await page.getByRole("button", { name: "Confirm Pause" }).click();
    await expect.poll(() => commands).toBe(1);
    await page.getByRole("tab", { name: "Task graph" }).click();
    await expect(page.getByRole("group", { name: "Task dependency graph" })).toBeVisible();
    await page.getByRole("button", { name: "task-1: Check documentation" }).click();
    await expect(page.getByText("Updated links")).toBeVisible();
    await page.getByRole("tab", { name: "Integration & review" }).click();
    await expect(page.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open diff" }).click();
    await expect(page.getByText(/old link/)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`swarm-${theme}.png`), fullPage: true });
    offline = true;
    await expect(page.getByRole("alert").filter({ hasText: "Stale state" })).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath(`swarm-${theme}-mobile.png`), fullPage: true });
  });
}
