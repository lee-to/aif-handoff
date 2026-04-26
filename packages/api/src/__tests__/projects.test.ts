import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projects, runtimeProfiles, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const mockInternalBroadcastToken = { value: "" };
const baseMockEnv = {
  AIF_DEFAULT_RUNTIME_ID: "claude",
  AIF_DEFAULT_PROVIDER_ID: "anthropic",
  INTERNAL_BROADCAST_TOKEN: "",
};

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      ...baseMockEnv,
      INTERNAL_BROADCAST_TOKEN: mockInternalBroadcastToken.value,
    }),
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/runtime", () => ({
  initProject: vi.fn(() => ({ ok: true })),
  bootstrapRuntimeRegistry: vi.fn(() =>
    Promise.resolve({
      resolveRuntime: vi.fn(),
      listRuntimes: vi.fn(() => []),
      registerRuntimeModule: vi.fn(),
    }),
  ),
}));

vi.mock("../services/runtime.js", () => ({
  getApiRuntimeRegistry: vi.fn(() =>
    Promise.resolve({
      resolveRuntime: vi.fn(),
      listRuntimes: vi.fn(() => []),
    }),
  ),
}));

vi.mock("../ws.js", () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
  setupWebSocket: vi.fn(() => ({
    injectWebSocket: vi.fn(),
    upgradeWebSocket: vi.fn(),
  })),
  getInjectWebSocket: vi.fn(),
}));

const { projectsRouter } = await import("../routes/projects.js");

function createApp() {
  const app = new Hono();
  app.route("/projects", projectsRouter);
  return app;
}

describe("projects API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockBroadcast.mockReset();
    mockInternalBroadcastToken.value = "";
    vi.stubEnv("NODE_ENV", "test");
  });

  it("returns projects list", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("rejects invalid root path for create", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Path",
        rootPath: "relative/path",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects invalid root path for update", async () => {
    const db = testDb.current;
    db.insert(projects).values({ id: "upd-proj", name: "Updatable", rootPath: "/tmp/valid" }).run();

    const res = await app.request("/projects/upd-proj", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated",
        rootPath: "relative/path",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns MCP servers from .mcp.json", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "aif-mcp-"));
    writeFileSync(
      join(rootPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { test: { command: "echo" } } }),
    );

    const db = testDb.current;
    db.insert(projects).values({ id: "mcp-proj", name: "MCP Project", rootPath }).run();

    const res = await app.request("/projects/mcp-proj/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers.test).toBeDefined();
  });

  it("returns empty object when .mcp.json does not exist", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "aif-no-mcp-"));

    const db = testDb.current;
    db.insert(projects).values({ id: "no-mcp-proj", name: "No MCP", rootPath }).run();

    const res = await app.request("/projects/no-mcp-proj/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers).toEqual({});
  });

  it("returns 404 for non-existent project MCP servers", async () => {
    const res = await app.request("/projects/missing-project/mcp");
    expect(res.status).toBe(404);
  });

  it("returns empty object when .mcp.json has no mcpServers key", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "aif-mcp-nokey-"));
    writeFileSync(join(rootPath, ".mcp.json"), JSON.stringify({ other: true }));

    const db = testDb.current;
    db.insert(projects).values({ id: "mcp-nokey-proj", name: "MCP No Key", rootPath }).run();

    const res = await app.request("/projects/mcp-nokey-proj/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers).toEqual({});
  });

  it("returns empty object when .mcp.json is invalid JSON", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "aif-mcp-bad-"));
    writeFileSync(join(rootPath, ".mcp.json"), "not json{{{");

    const db = testDb.current;
    db.insert(projects).values({ id: "mcp-bad-proj", name: "MCP Bad JSON", rootPath }).run();

    const res = await app.request("/projects/mcp-bad-proj/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers).toEqual({});
  });

  describe("GET /projects/:id/roadmap/status", () => {
    it("returns exists: true when ROADMAP.md is present", async () => {
      const rootPath = mkdtempSync(join(tmpdir(), "aif-roadmap-"));
      const aifDir = join(rootPath, ".ai-factory");
      mkdirSync(aifDir, { recursive: true });
      writeFileSync(join(aifDir, "ROADMAP.md"), "# Roadmap\n");

      const db = testDb.current;
      db.insert(projects).values({ id: "rm-exists", name: "RM Exists", rootPath }).run();

      const res = await app.request("/projects/rm-exists/roadmap/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(true);
    });

    it("returns exists: false when ROADMAP.md is missing", async () => {
      const rootPath = mkdtempSync(join(tmpdir(), "aif-no-roadmap-"));

      const db = testDb.current;
      db.insert(projects).values({ id: "rm-missing", name: "RM Missing", rootPath }).run();

      const res = await app.request("/projects/rm-missing/roadmap/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(false);
    });

    it("returns 404 for non-existent project", async () => {
      const res = await app.request("/projects/no-such-project/roadmap/status");
      expect(res.status).toBe(404);
    });
  });

  it("returns 500 and rolls back project when ai-factory init fails", async () => {
    const { initProject: initProjectMock } = await import("@aif/runtime");
    (initProjectMock as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ok: false,
      error: "ai-factory init failed: command not found",
    });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Demo",
        rootPath: "/tmp/demo-project",
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("ai-factory init failed");

    // Verify project was rolled back from DB
    const listRes = await app.request("/projects");
    const projects = await listRes.json();
    expect(projects.find((p: { name: string }) => p.name === "Demo")).toBeUndefined();
  });

  it("returns 500 and rolls back project when runtime registry throws", async () => {
    const { getApiRuntimeRegistry } = await import("../services/runtime.js");
    (getApiRuntimeRegistry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("registry unavailable"),
    );

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "RegistryFail",
        rootPath: "/tmp/registry-fail-project",
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("registry unavailable");

    // Verify project was rolled back from DB
    const listRes = await app.request("/projects");
    const projects = await listRes.json();
    expect(projects.find((p: { name: string }) => p.name === "RegistryFail")).toBeUndefined();
  });

  it("creates project successfully when init passes", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Demo",
        rootPath: "/tmp/demo-project",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Demo");
    expect(body.rootPath).toBe("/tmp/demo-project");
  });

  it("rejects foreign project-owned runtime profile defaults on create", async () => {
    testDb.current
      .insert(runtimeProfiles)
      .values({
        id: "other-project-profile",
        projectId: "other-project",
        name: "Other Project Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Defaults",
        rootPath: "/tmp/invalid-defaults-project",
        defaultTaskRuntimeProfileId: "other-project-profile",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.fieldErrors.defaultTaskRuntimeProfileId).toBeDefined();
  });

  it("persists per-stage runtime profile IDs on project update", async () => {
    testDb.current
      .insert(runtimeProfiles)
      .values([
        {
          id: "profile-task",
          projectId: null,
          name: "Task Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-chat",
          projectId: null,
          name: "Chat Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();

    // Create a project first
    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Staged", rootPath: "/tmp/staged-project" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    testDb.current
      .insert(runtimeProfiles)
      .values([
        {
          id: "profile-plan",
          projectId: created.id,
          name: "Plan Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-review",
          projectId: created.id,
          name: "Review Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();

    // Update with per-stage profile IDs
    const updateRes = await app.request(`/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Staged",
        rootPath: "/tmp/staged-project",
        defaultTaskRuntimeProfileId: "profile-task",
        defaultPlanRuntimeProfileId: "profile-plan",
        defaultReviewRuntimeProfileId: "profile-review",
        defaultChatRuntimeProfileId: "profile-chat",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();

    expect(updated.defaultTaskRuntimeProfileId).toBe("profile-task");
    expect(updated.defaultPlanRuntimeProfileId).toBe("profile-plan");
    expect(updated.defaultReviewRuntimeProfileId).toBe("profile-review");
    expect(updated.defaultChatRuntimeProfileId).toBe("profile-chat");

    // Verify persistence by re-fetching
    const getRes = await app.request(`/projects`);
    const projects = await getRes.json();
    const refetched = projects.find((p: { id: string }) => p.id === created.id);
    expect(refetched.defaultPlanRuntimeProfileId).toBe("profile-plan");
    expect(refetched.defaultReviewRuntimeProfileId).toBe("profile-review");
  });

  it("preserves project runtime defaults when update payload omits them", async () => {
    testDb.current
      .insert(runtimeProfiles)
      .values([
        {
          id: "profile-task",
          projectId: null,
          name: "Task Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-plan",
          projectId: null,
          name: "Plan Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-review",
          projectId: null,
          name: "Review Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-chat",
          projectId: null,
          name: "Chat Profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();

    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Runtime Defaults",
        rootPath: "/tmp/runtime-defaults-project",
        defaultTaskRuntimeProfileId: "profile-task",
        defaultPlanRuntimeProfileId: "profile-plan",
        defaultReviewRuntimeProfileId: "profile-review",
        defaultChatRuntimeProfileId: "profile-chat",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const updateRes = await app.request(`/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Runtime Defaults Renamed",
        rootPath: "/tmp/runtime-defaults-project-renamed",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.defaultTaskRuntimeProfileId).toBe("profile-task");
    expect(updated.defaultPlanRuntimeProfileId).toBe("profile-plan");
    expect(updated.defaultReviewRuntimeProfileId).toBe("profile-review");
    expect(updated.defaultChatRuntimeProfileId).toBe("profile-chat");

    const clearRes = await app.request(`/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Runtime Defaults Renamed",
        rootPath: "/tmp/runtime-defaults-project-renamed",
        defaultPlanRuntimeProfileId: null,
      }),
    });
    expect(clearRes.status).toBe(200);
    const cleared = await clearRes.json();
    expect(cleared.defaultTaskRuntimeProfileId).toBe("profile-task");
    expect(cleared.defaultPlanRuntimeProfileId).toBeNull();
    expect(cleared.defaultReviewRuntimeProfileId).toBe("profile-review");
    expect(cleared.defaultChatRuntimeProfileId).toBe("profile-chat");
  });

  it("rejects foreign project-owned runtime profile defaults on update", async () => {
    testDb.current
      .insert(runtimeProfiles)
      .values({
        id: "other-project-profile",
        projectId: "other-project",
        name: "Other Project Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Scoped", rootPath: "/tmp/scoped-project" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const updateRes = await app.request(`/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Scoped",
        rootPath: "/tmp/scoped-project",
        defaultTaskRuntimeProfileId: "other-project-profile",
      }),
    });

    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.error).toBeTruthy();
    expect(body.fieldErrors.defaultTaskRuntimeProfileId).toBeDefined();
  });

  it("rejects disabled runtime profile defaults on update", async () => {
    testDb.current
      .insert(runtimeProfiles)
      .values({
        id: "disabled-global-profile",
        projectId: null,
        name: "Disabled Global",
        runtimeId: "codex",
        providerId: "openai",
        enabled: false,
      })
      .run();

    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Scoped", rootPath: "/tmp/scoped-project-disabled" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const updateRes = await app.request(`/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Scoped",
        rootPath: "/tmp/scoped-project-disabled",
        defaultTaskRuntimeProfileId: "disabled-global-profile",
      }),
    });

    expect(updateRes.status).toBe(400);
    const body = await updateRes.json();
    expect(body.error).toBeTruthy();
    expect(body.fieldErrors.defaultTaskRuntimeProfileId).toBeDefined();
  });

  describe("auto-queue mode", () => {
    beforeEach(() => {
      testDb.current.insert(projects).values({ id: "p-1", name: "P1", rootPath: "/tmp/p1" }).run();
    });

    it("GET returns disabled by default", async () => {
      const res = await app.request("/projects/p-1/auto-queue-mode");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
    });

    it("PATCH toggles and persists", async () => {
      const res = await app.request("/projects/p-1/auto-queue-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true });
      const get = await app.request("/projects/p-1/auto-queue-mode");
      expect(await get.json()).toEqual({ enabled: true });
    });

    it("PATCH rejects invalid body", async () => {
      const res = await app.request("/projects/p-1/auto-queue-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown project", async () => {
      const res = await app.request("/projects/missing/auto-queue-mode");
      expect(res.status).toBe(404);
    });
  });

  it("broadcasts runtime-limit updates with project-scoped payloads", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "proj-broadcast", name: "Broadcast", rootPath: "/tmp/b" })
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-1",
        projectId: "proj-broadcast",
        name: "Broadcast Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects/proj-broadcast/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-broadcast",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      },
    });
  });

  it("rejects unauthorized broadcast request when internal token is configured", async () => {
    const db = testDb.current;
    mockInternalBroadcastToken.value = "internal-token";
    db.insert(projects)
      .values({ id: "proj-broadcast-auth", name: "Broadcast Auth", rootPath: "/tmp/ba" })
      .run();

    const res = await app.request("/projects/proj-broadcast-auth/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(401);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects spoofed loopback headers in production when no internal token is configured", async () => {
    const db = testDb.current;
    vi.stubEnv("NODE_ENV", "production");
    db.insert(projects)
      .values({ id: "proj-broadcast-prod", name: "Broadcast Prod", rootPath: "/tmp/bp" })
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-1",
        projectId: "proj-broadcast-prod",
        name: "Broadcast Prod Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects/proj-broadcast-prod/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3009",
        "X-Forwarded-For": "127.0.0.1",
        "X-Real-IP": "127.0.0.1",
      },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-1",
      }),
    });

    expect(res.status).toBe(401);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("accepts authorized broadcast request with internal token header", async () => {
    const db = testDb.current;
    mockInternalBroadcastToken.value = "internal-token";
    db.insert(projects)
      .values({ id: "proj-broadcast-auth-ok", name: "Broadcast Auth OK", rootPath: "/tmp/bao" })
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-1",
        projectId: "proj-broadcast-auth-ok",
        name: "Broadcast Auth Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects/proj-broadcast-auth-ok/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Broadcast-Token": "internal-token",
      },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-broadcast-auth-ok",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      },
    });
  });

  it("accepts authorized broadcast request with bearer token", async () => {
    const db = testDb.current;
    mockInternalBroadcastToken.value = "internal-token";
    db.insert(projects)
      .values({
        id: "proj-broadcast-auth-bearer",
        name: "Broadcast Auth Bearer",
        rootPath: "/tmp/bab",
      })
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-1",
        projectId: "proj-broadcast-auth-bearer",
        name: "Broadcast Bearer Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects/proj-broadcast-auth-bearer/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer internal-token",
      },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-broadcast-auth-bearer",
        runtimeProfileId: "profile-1",
        taskId: "task-1",
      },
    });
  });

  it("rejects runtime-limit broadcasts when the runtime profile belongs to another project", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values([
        { id: "proj-runtime-a", name: "Project A", rootPath: "/tmp/a" },
        { id: "proj-runtime-b", name: "Project B", rootPath: "/tmp/b" },
      ])
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-other-project",
        projectId: "proj-runtime-b",
        name: "Other Project Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/projects/proj-runtime-a/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
        runtimeProfileId: "profile-other-project",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "runtimeProfileId must belong to the target project or be global",
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects runtime-limit broadcasts without a runtimeProfileId", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "proj-runtime-missing", name: "Project Missing", rootPath: "/tmp/missing" })
      .run();

    const res = await app.request("/projects/proj-runtime-missing/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project:runtime_limit_updated",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "runtimeProfileId is required for project:runtime_limit_updated",
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects auto-queue broadcasts when the task belongs to another project", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values([
        { id: "proj-queue-a", name: "Project A", rootPath: "/tmp/a" },
        { id: "proj-queue-b", name: "Project B", rootPath: "/tmp/b" },
      ])
      .run();
    db.insert(tasks)
      .values({
        id: "task-other-project",
        projectId: "proj-queue-b",
        title: "Other project task",
        status: "backlog",
      })
      .run();

    const res = await app.request("/projects/proj-queue-a/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project:auto_queue_advanced",
        taskId: "task-other-project",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "taskId does not belong to the target project",
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
