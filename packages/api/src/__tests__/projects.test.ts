import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const mockInitProjectDirectory = vi.fn();

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    initProjectDirectory: (projectRoot: string) => mockInitProjectDirectory(projectRoot),
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
  broadcast: vi.fn(),
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
    mockInitProjectDirectory.mockReset();
    app = createApp();
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

  it("persists per-stage runtime profile IDs on project update", async () => {
    // Create a project first
    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Staged", rootPath: "/tmp/staged-project" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

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
});
