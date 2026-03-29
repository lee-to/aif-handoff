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

  it("creates project even when directory initialization fails", async () => {
    mockInitProjectDirectory.mockImplementation(() => {
      throw new Error("permission denied");
    });

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
});
