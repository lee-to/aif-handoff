import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const pilot = { enabled: true };

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.validateEnv({}), AIF_KERRY_PILOT_MODE: pilot.enabled }),
  };
});

const { pilotModePolicy } = await import("../middleware/requireRole.js");

function createApp() {
  const app = new Hono();
  app.use("*", pilotModePolicy());
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("Kerry pilot policy", () => {
  it("blocks execution but allows planning metadata", async () => {
    const app = createApp();
    for (const [method, path] of [
      ["POST", "/chat"],
      ["POST", "/tasks/task-1/handoff"],
      ["POST", "/tasks/task-1/run-qa"],
      ["POST", "/projects/project-1/roadmap"],
      ["POST", "/projects/project-1/roadmap/import"],
      ["PATCH", "/projects/project-1/auto-queue-mode"],
      ["PUT", "/projects/project-1/github"],
      ["DELETE", "/projects/project-1/github"],
      ["POST", "/projects/project-1/github/sync"],
      ["POST", "/runtime-profiles"],
      ["PUT", "/settings/runtime-defaults"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "pilot_execution_disabled" });
    }

    expect((await app.request("/tasks", { method: "POST" })).status).toBe(200);
    expect((await app.request("/chat/sessions", { method: "POST" })).status).toBe(200);
    expect(
      (await app.request("/chat/sessions/thread-1/objectives", { method: "POST" })).status,
    ).toBe(200);
  });

  it("does not change routes when pilot mode is off", async () => {
    pilot.enabled = false;
    expect((await createApp().request("/chat", { method: "POST" })).status).toBe(200);
    pilot.enabled = true;
  });
});
