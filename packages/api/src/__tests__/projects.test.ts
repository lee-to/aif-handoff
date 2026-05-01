import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { projects, runtimeProfiles, runtimeWarmupSessions, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const mockInternalBroadcastToken = { value: "" };
const mockWarmupEnabled = { value: false };
const mockTaskWorktreesEnabled = { value: false };
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
      AIF_WARMUP_ENABLED: mockWarmupEnabled.value,
      AIF_TASK_WORKTREES_ENABLED: mockTaskWorktreesEnabled.value,
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

const mockResolveApiWarmupSupport = vi.fn();
const mockResolveApiWarmupSupports = vi.fn();
const mockRunApiRuntimeOneShot = vi.fn();

vi.mock("../services/runtime.js", () => ({
  getApiRuntimeRegistry: vi.fn(() =>
    Promise.resolve({
      resolveRuntime: vi.fn(),
      listRuntimes: vi.fn(() => []),
    }),
  ),
  resolveApiWarmupSupport: (...args: unknown[]) => mockResolveApiWarmupSupport(...args),
  resolveApiWarmupSupports: (...args: unknown[]) => mockResolveApiWarmupSupports(...args),
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function createApp() {
  const app = new Hono();
  app.route("/projects", projectsRouter);
  return app;
}

describe("projects API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDb.current = createTestDb();
    app = createApp();
    mockBroadcast.mockReset();
    mockInternalBroadcastToken.value = "";
    mockWarmupEnabled.value = false;
    mockTaskWorktreesEnabled.value = false;
    mockResolveApiWarmupSupport.mockReset();
    const unsupportedWarmup = {
      supported: false,
      skipReason: "unsupported_capability",
      workflowKind: "planner",
      profileMode: "plan",
      runtimeId: "openrouter",
      providerId: "openrouter",
      runtimeProfileId: null,
      transport: "api",
      model: "openrouter/auto",
      selectionSource: "none",
    };
    mockResolveApiWarmupSupport.mockResolvedValue(unsupportedWarmup);
    mockResolveApiWarmupSupports.mockReset();
    mockResolveApiWarmupSupports.mockResolvedValue([unsupportedWarmup]);
    mockRunApiRuntimeOneShot.mockReset();
    mockRunApiRuntimeOneShot.mockResolvedValue({
      result: {
        outputText: "Warmup summary",
        sessionId: "seed-session-1",
        usage: null,
      },
      context: {},
    });
    vi.unstubAllEnvs();
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

  it("maps Docker host project paths to the container project mount on create", async () => {
    vi.stubEnv("PROJECTS_DIR", "/Users/dev/projects");
    vi.stubEnv("PROJECTS_MOUNT", "/home/www");
    const { initProject: initProjectMock } = await import("@aif/runtime");

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Docker Project",
        rootPath: "/Users/dev/projects/demo",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rootPath).toBe("/home/www/demo");
    expect(initProjectMock).toHaveBeenCalledWith({
      projectRoot: "/home/www/demo",
      registry: expect.anything(),
    });
  });

  it("maps Docker quick-start project paths when compose provides default mount env", async () => {
    const defaultHostProjectsDir = join(repoRoot, "projects");
    vi.stubEnv("PROJECTS_DIR", defaultHostProjectsDir);
    vi.stubEnv("PROJECTS_MOUNT", "/home/www");
    const { initProject: initProjectMock } = await import("@aif/runtime");

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Docker Default Project",
        rootPath: join(defaultHostProjectsDir, "demo"),
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rootPath).toBe("/home/www/demo");
    expect(initProjectMock).toHaveBeenCalledWith({
      projectRoot: "/home/www/demo",
      registry: expect.anything(),
    });
  });

  it("maps Docker project paths when PROJECTS_DIR is relative to the compose root", async () => {
    vi.stubEnv("PROJECTS_DIR", "./.projects");
    vi.stubEnv("PROJECTS_HOST_ROOT", repoRoot);
    vi.stubEnv("PROJECTS_MOUNT", "/home/www");
    const { initProject: initProjectMock } = await import("@aif/runtime");

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Docker Relative Project",
        rootPath: join(repoRoot, ".projects", "demo"),
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rootPath).toBe("/home/www/demo");
    expect(initProjectMock).toHaveBeenCalledWith({
      projectRoot: "/home/www/demo",
      registry: expect.anything(),
    });
  });

  it("wires default Docker project mount env into the API service", () => {
    const compose = YAML.parse(readFileSync(join(repoRoot, "docker-compose.yml"), "utf-8"));

    expect(compose.services.api.environment).toEqual(
      expect.arrayContaining([
        "PROJECTS_DIR=${PROJECTS_DIR:-${PWD}/projects}",
        "PROJECTS_HOST_ROOT=${PWD}",
        "PROJECTS_MOUNT=${PROJECTS_MOUNT:-/home/www}",
      ]),
    );
    expect(compose.services.api.volumes).toEqual(
      expect.arrayContaining(["${PROJECTS_DIR:-${PWD}/projects}:${PROJECTS_MOUNT:-/home/www}"]),
    );
  });

  it("maps Docker host project paths to the container project mount on update", async () => {
    vi.stubEnv("PROJECTS_DIR", "/Users/dev/projects");
    vi.stubEnv("PROJECTS_MOUNT", "/workspace");
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "docker-proj", name: "Docker", rootPath: "/workspace/old" })
      .run();

    const res = await app.request("/projects/docker-proj", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Docker Updated",
        rootPath: "/Users/dev/projects/demo",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rootPath).toBe("/workspace/demo");
  });

  it("rejects enabling parallel execution when auto-queue is already enabled with git.create_branches=true and task worktrees are disabled", async () => {
    const rootPath = mkdtempSync("/tmp/aif-parallel-auto-queue-");
    testDb.current
      .insert(projects)
      .values({
        id: "branch-auto-queue",
        name: "Branch Auto Queue",
        rootPath,
        autoQueueMode: true,
      })
      .run();

    const res = await app.request("/projects/branch-auto-queue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Branch Auto Queue",
        rootPath,
        parallelEnabled: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("AIF_TASK_WORKTREES_ENABLED=true");
  });

  it("allows enabling parallel execution for branch-isolated auto-queue when task worktrees are enabled", async () => {
    mockTaskWorktreesEnabled.value = true;
    const rootPath = mkdtempSync("/tmp/aif-parallel-auto-queue-");
    testDb.current
      .insert(projects)
      .values({
        id: "branch-auto-queue-enabled",
        name: "Branch Auto Queue",
        rootPath,
        autoQueueMode: true,
      })
      .run();

    const res = await app.request("/projects/branch-auto-queue-enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Branch Auto Queue",
        rootPath,
        parallelEnabled: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parallelEnabled).toBe(true);
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

    it("PATCH rejects enabling auto-queue for parallel projects with git.create_branches=true and task worktrees disabled", async () => {
      const rootPath = mkdtempSync("/tmp/aif-auto-queue-branch-");
      testDb.current
        .insert(projects)
        .values({
          id: "p-branch",
          name: "Branch Project",
          rootPath,
          parallelEnabled: true,
        })
        .run();

      const res = await app.request("/projects/p-branch/auto-queue-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("AIF_TASK_WORKTREES_ENABLED=true");
    });

    it("PATCH allows enabling auto-queue for parallel branch-isolated projects when task worktrees are enabled", async () => {
      mockTaskWorktreesEnabled.value = true;
      const rootPath = mkdtempSync("/tmp/aif-auto-queue-branch-");
      testDb.current
        .insert(projects)
        .values({
          id: "p-branch-enabled",
          name: "Branch Project",
          rootPath,
          parallelEnabled: true,
        })
        .run();

      const res = await app.request("/projects/p-branch-enabled/auto-queue-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true });
    });

    it("PATCH allows parallel auto-queue when git.create_branches=false", async () => {
      const rootPath = mkdtempSync(join(tmpdir(), "aif-auto-queue-no-branch-"));
      mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
      writeFileSync(
        join(rootPath, ".ai-factory", "config.yaml"),
        "git:\n  create_branches: false\n",
      );
      testDb.current
        .insert(projects)
        .values({
          id: "p-no-branch",
          name: "No Branch Project",
          rootPath,
          parallelEnabled: true,
        })
        .run();

      const res = await app.request("/projects/p-no-branch/auto-queue-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true });
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

  describe("warmup routes", () => {
    beforeEach(() => {
      testDb.current
        .insert(projects)
        .values({ id: "warm-project", name: "Warm Project", rootPath: "/tmp/warm-project" })
        .run();
    });

    function mockSupportedWarmup() {
      const supportedWarmup = {
        supported: true,
        workflowKind: "planner",
        profileMode: "plan",
        runtimeId: "claude",
        providerId: "anthropic",
        runtimeProfileId: "profile-warm",
        transport: "sdk",
        model: "claude-sonnet-4",
        selectionSource: "project_default",
      };
      mockResolveApiWarmupSupport.mockResolvedValue(supportedWarmup);
      mockResolveApiWarmupSupports.mockResolvedValue([supportedWarmup]);
    }

    it("GET returns feature and support metadata with no active warmup", async () => {
      mockWarmupEnabled.value = true;
      mockSupportedWarmup();

      const res = await app.request("/projects/warm-project/warmup");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          enabled: true,
          support: expect.objectContaining({
            supported: true,
            workflowKind: "planner",
            profileMode: "plan",
            runtimeId: "claude",
            runtimeProfileId: "profile-warm",
            transport: "sdk",
          }),
          targets: [
            expect.objectContaining({
              supported: true,
              workflowKind: "planner",
              profileMode: "plan",
              runtimeId: "claude",
              runtimeProfileId: "profile-warm",
              transport: "sdk",
            }),
          ],
          warmup: null,
          warmups: [],
        }),
      );
    });

    it("POST rejects when the warmup feature flag is disabled", async () => {
      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "Warmup is disabled",
        code: "feature_disabled",
      });
      expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
    });

    it("POST rejects unsupported warmup runtimes", async () => {
      mockWarmupEnabled.value = true;
      mockResolveApiWarmupSupport.mockResolvedValue({
        supported: false,
        skipReason: "unsupported_capability",
        workflowKind: "planner",
        profileMode: "plan",
        runtimeId: "openrouter",
        providerId: "openrouter",
        runtimeProfileId: null,
        transport: "api",
        model: "openrouter/auto",
        selectionSource: "none",
      });
      mockResolveApiWarmupSupports.mockResolvedValue([
        {
          supported: false,
          skipReason: "unsupported_capability",
          workflowKind: "planner",
          profileMode: "plan",
          runtimeId: "openrouter",
          providerId: "openrouter",
          runtimeProfileId: null,
          transport: "api",
          model: "openrouter/auto",
          selectionSource: "none",
        },
      ]);

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("unsupported_capability");
      expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
    });

    it("POST validates TTL bounds", async () => {
      mockWarmupEnabled.value = true;
      mockSupportedWarmup();

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 1 }),
      });

      expect(res.status).toBe(400);
    });

    it("POST creates and persists a ready warmup seed session", async () => {
      mockWarmupEnabled.value = true;
      mockSupportedWarmup();

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.warmup).toEqual(
        expect.objectContaining({
          projectId: "warm-project",
          runtimeProfileId: "profile-warm",
          runtimeId: "claude",
          providerId: "anthropic",
          transport: "sdk",
          model: "claude-sonnet-4",
          status: "ready",
          ttlSeconds: 600,
          summary: "Warmup summary",
        }),
      );
      expect(body.warmup).not.toHaveProperty("sourceSessionId");
      expect(mockRunApiRuntimeOneShot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "warm-project",
          projectRoot: "/tmp/warm-project",
          workflowKind: "planner",
          usageContext: { source: "warmup" },
        }),
      );
      const rows = testDb.current.select().from(runtimeWarmupSessions).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          status: "ready",
          sourceSessionId: "seed-session-1",
        }),
      );
      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "project:warmup_updated",
        payload: { projectId: "warm-project", status: "ready" },
      });
    });

    it("POST preserves the previous ready warmup when regeneration fails", async () => {
      mockWarmupEnabled.value = true;
      mockSupportedWarmup();
      testDb.current
        .insert(runtimeWarmupSessions)
        .values({
          id: "warmup-old",
          projectId: "warm-project",
          runtimeProfileId: "profile-warm",
          runtimeId: "claude",
          providerId: "anthropic",
          transport: "sdk",
          model: "claude-sonnet-4",
          sourceSessionId: "seed-old",
          status: "ready",
          ttlSeconds: 600,
          expiresAt: "2026-05-01T12:00:00.000Z",
          summary: "Old warmup",
          errorMessage: null,
          createdAt: "2026-05-01T11:00:00.000Z",
          updatedAt: "2026-05-01T11:00:00.000Z",
        })
        .run();
      mockRunApiRuntimeOneShot.mockRejectedValue(new Error("runtime unavailable"));

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe("runtime_failed");
      expect(body.warmups).toEqual([
        expect.objectContaining({
          id: "warmup-old",
          status: "ready",
          summary: "Old warmup",
        }),
      ]);
      expect(
        testDb.current
          .select()
          .from(runtimeWarmupSessions)
          .all()
          .filter((row) => row.id === "warmup-old")[0]?.status,
      ).toBe("ready");
    });

    it("POST creates warmup seeds for distinct planner, implementer, and review runtimes", async () => {
      mockWarmupEnabled.value = true;
      mockResolveApiWarmupSupports.mockResolvedValue([
        {
          supported: true,
          workflowKind: "planner",
          profileMode: "plan",
          runtimeId: "claude",
          providerId: "anthropic",
          runtimeProfileId: "profile-plan",
          transport: "sdk",
          model: "claude-plan",
          selectionSource: "project_default",
        },
        {
          supported: true,
          workflowKind: "implementer",
          profileMode: "task",
          runtimeId: "codex",
          providerId: "openai",
          runtimeProfileId: "profile-impl",
          transport: "app-server",
          model: "gpt-5.5",
          selectionSource: "project_default",
        },
        {
          supported: true,
          workflowKind: "reviewer",
          profileMode: "review",
          runtimeId: "claude",
          providerId: "anthropic",
          runtimeProfileId: "profile-review",
          transport: "sdk",
          model: "claude-review",
          selectionSource: "project_default",
        },
      ]);
      mockRunApiRuntimeOneShot.mockImplementation((input: { workflowKind: string }) =>
        Promise.resolve({
          result: {
            outputText: `Warmup ${input.workflowKind}`,
            sessionId: `seed-${input.workflowKind}`,
            usage: null,
          },
          context: {},
        }),
      );

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.warmups).toHaveLength(3);
      expect(mockRunApiRuntimeOneShot).toHaveBeenCalledTimes(3);
      expect(mockRunApiRuntimeOneShot).toHaveBeenCalledWith(
        expect.objectContaining({ workflowKind: "planner", profileMode: "plan" }),
      );
      expect(mockRunApiRuntimeOneShot).toHaveBeenCalledWith(
        expect.objectContaining({ workflowKind: "implementer", profileMode: "task" }),
      );
      expect(mockRunApiRuntimeOneShot).toHaveBeenCalledWith(
        expect.objectContaining({ workflowKind: "reviewer", profileMode: "review" }),
      );
      const rows = testDb.current.select().from(runtimeWarmupSessions).all();
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeProfileId: "profile-plan",
            sourceSessionId: "seed-planner",
          }),
          expect.objectContaining({
            runtimeProfileId: "profile-impl",
            sourceSessionId: "seed-implementer",
          }),
          expect.objectContaining({
            runtimeProfileId: "profile-review",
            sourceSessionId: "seed-reviewer",
          }),
        ]),
      );
    });

    it("POST returns partial warmup results when a later target fails", async () => {
      mockWarmupEnabled.value = true;
      mockResolveApiWarmupSupports.mockResolvedValue([
        {
          supported: true,
          workflowKind: "planner",
          profileMode: "plan",
          runtimeId: "claude",
          providerId: "anthropic",
          runtimeProfileId: "profile-plan",
          transport: "sdk",
          model: "claude-plan",
          selectionSource: "project_default",
        },
        {
          supported: true,
          workflowKind: "implementer",
          profileMode: "task",
          runtimeId: "codex",
          providerId: "openai",
          runtimeProfileId: "profile-impl",
          transport: "app-server",
          model: "gpt-5.5",
          selectionSource: "project_default",
        },
      ]);
      mockRunApiRuntimeOneShot
        .mockResolvedValueOnce({
          result: { outputText: "Warmup planner", sessionId: "seed-planner", usage: null },
          context: {},
        })
        .mockRejectedValueOnce(new Error("codex warmup failed"));

      const res = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });

      expect(res.status).toBe(207);
      const body = await res.json();
      expect(body).toEqual(
        expect.objectContaining({
          code: "partial_warmup_failed",
          failedTarget: "implementer",
          partial: true,
        }),
      );
      expect(body.warmups).toEqual([
        expect.objectContaining({
          runtimeProfileId: "profile-plan",
          status: "ready",
        }),
      ]);
      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "project:warmup_updated",
        payload: { projectId: "warm-project", status: "partial" },
      });
    });

    it("DELETE clears active warmup rows for the effective warmup scopes", async () => {
      mockWarmupEnabled.value = true;
      mockSupportedWarmup();

      const createRes = await app.request("/projects/warm-project/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 600 }),
      });
      expect(createRes.status).toBe(201);
      mockBroadcast.mockClear();

      const deleteRes = await app.request("/projects/warm-project/warmup", {
        method: "DELETE",
      });

      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toEqual({ success: true, cleared: 1 });
      expect(testDb.current.select().from(runtimeWarmupSessions).get()?.status).toBe("cleared");
      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "project:warmup_updated",
        payload: { projectId: "warm-project", status: "cleared" },
      });
    });

    it("returns 404 for missing projects", async () => {
      const res = await app.request("/projects/missing-project/warmup");
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
