import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tasks, taskComments, projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

// Mock the shared db module to use test db
const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Mock broadcast to prevent WS errors in tests
vi.mock("../ws.js", () => ({
  broadcast: vi.fn(),
  setupWebSocket: vi.fn(() => ({
    injectWebSocket: vi.fn(),
    upgradeWebSocket: vi.fn(),
  })),
  getInjectWebSocket: vi.fn(),
}));

// Mock attachment storage for download tests
const mockReadAttachment = vi.fn();
vi.mock("../services/attachmentStorage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/attachmentStorage.js")>();
  return {
    ...actual,
    readAttachment: (...args: unknown[]) => mockReadAttachment(...args),
  };
});

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

// Import after mocks
const { tasksRouter } = await import("../routes/tasks.js");

function createApp() {
  const app = new Hono();
  app.route("/tasks", tasksRouter);
  return app;
}

function createAppWithSettings() {
  const app = new Hono();
  app.get("/settings", async (c) => {
    const { getEnv } = await import("@aif/shared");
    const env = getEnv();
    return c.json({
      useSubagents: env.AGENT_USE_SUBAGENTS,
      maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
    });
  });
  return app;
}

function insertTestProject(db: ReturnType<typeof createTestDb>, rootPath = "/tmp/test-project") {
  db.insert(projects).values({ id: "test-project", name: "Test Project", rootPath }).run();
}

describe("tasks API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockQuery.mockReset();
    mockQuery.mockImplementation(async function* () {
      yield { type: "result", subtype: "success", result: "## Updated plan\n- Fast fix applied" };
    });
  });

  describe("GET /tasks", () => {
    it("should return empty list initially", async () => {
      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("should return all tasks", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "1", projectId: "test-project", title: "Task 1" }).run();
      db.insert(tasks).values({ id: "2", projectId: "test-project", title: "Task 2" }).run();

      const res = await app.request("/tasks");
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it("should return 400 for invalid projectId format", async () => {
      const res = await app.request("/tasks?projectId=not-a-uuid");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid projectId format/);
    });
  });

  describe("POST /tasks", () => {
    it("should create a task", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New task",
          description: "Description",
          priority: 2,
          projectId: "test-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe("New task");
      expect(body.description).toBe("Description");
      expect(body.priority).toBe(2);
      expect(body.autoMode).toBe(true);
      expect(body.isFix).toBe(false);
      expect(body.status).toBe("backlog");
    });

    it("should persist planner settings from create payload", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task with planner settings",
          projectId: "test-project",
          plannerMode: "fast",
          planPath: ".ai-factory/custom-plan.md",
          planDocs: true,
          planTests: true,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.plannerMode).toBe("fast");
      expect(body.planPath).toBe(".ai-factory/custom-plan.md");
      expect(body.planDocs).toBe(true);
      expect(body.planTests).toBe(true);
    });

    it("should persist skipReview from create payload", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task with skip review",
          projectId: "test-project",
          skipReview: true,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.skipReview).toBe(true);
    });

    it("should default skipReview to false", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task without skip review",
          projectId: "test-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.skipReview).toBe(false);
    });

    it("should persist useSubagents from create payload", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task without subagents",
          projectId: "test-project",
          useSubagents: false,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.useSubagents).toBe(false);
    });

    it("should default useSubagents to AGENT_USE_SUBAGENTS env value", async () => {
      const { getEnv } = await import("@aif/shared");
      const envDefault = getEnv().AGENT_USE_SUBAGENTS;

      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task with default subagents",
          projectId: "test-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.useSubagents).toBe(envDefault);
    });

    it("should create a task with explicit maxReviewIterations", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task with max iterations",
          projectId: "test-project",
          maxReviewIterations: 5,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.maxReviewIterations).toBe(5);
      expect(body.reviewIterationCount).toBe(0);
    });

    it("should default maxReviewIterations to AGENT_MAX_REVIEW_ITERATIONS env value", async () => {
      const { getEnv } = await import("@aif/shared");
      const envDefault = getEnv().AGENT_MAX_REVIEW_ITERATIONS;

      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task with default max iterations",
          projectId: "test-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.maxReviewIterations).toBe(envDefault);
    });

    it("should create a fix task when isFix=true", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix task",
          description: "Fix mode task",
          projectId: "test-project",
          isFix: true,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isFix).toBe(true);
    });

    it("should create a task with paused=true", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Paused task",
          projectId: "test-project",
          paused: true,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.paused).toBe(true);
    });

    it("should default paused to false", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Default paused task",
          projectId: "test-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.paused).toBe(false);
    });

    it("should reject empty title", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "", projectId: "test-project" }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject missing title", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "No title", projectId: "test-project" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /tasks/:id", () => {
    it("should return a task by id", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "test-1", projectId: "test-project", title: "Find me" }).run();

      const res = await app.request("/tasks/test-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Find me");
    });

    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/non-existent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /tasks/:id", () => {
    it("should update a task", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "upd-1", projectId: "test-project", title: "Original" }).run();

      const res = await app.request("/tasks/upd-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Updated");
    });

    it("should update maxReviewIterations", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "upd-mri", projectId: "test-project", title: "Iter task" })
        .run();

      const res = await app.request("/tasks/upd-mri", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxReviewIterations: 10 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.maxReviewIterations).toBe(10);
    });

    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/non-existent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      });

      expect(res.status).toBe(404);
    });

    it("should update skipReview via PUT", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "upd-sr", projectId: "test-project", title: "SR task" }).run();

      const res = await app.request("/tasks/upd-sr", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipReview: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipReview).toBe(true);
    });

    it("should update useSubagents via PUT", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "upd-usa", projectId: "test-project", title: "USA task" })
        .run();

      const res = await app.request("/tasks/upd-usa", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useSubagents: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.useSubagents).toBe(false);
    });

    it("should update paused via PUT", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "upd-paused", projectId: "test-project", title: "Pause test" })
        .run();

      const res = await app.request("/tasks/upd-paused", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.paused).toBe(true);
    });

    it("should update autoMode via PUT", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "upd-auto", projectId: "test-project", title: "Auto task" })
        .run();

      const res = await app.request("/tasks/upd-auto", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMode: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoMode).toBe(false);
    });

    it("should update planner settings via PUT", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "upd-planner", projectId: "test-project", title: "Planner task" })
        .run();

      const res = await app.request("/tasks/upd-planner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plannerMode: "fast",
          planPath: ".ai-factory/custom.md",
          planDocs: true,
          planTests: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plannerMode).toBe("fast");
      expect(body.planPath).toBe(".ai-factory/custom.md");
      expect(body.planDocs).toBe(true);
      expect(body.planTests).toBe(true);
    });

    it("should handle attachments update via PUT", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-put-attach-"));
      mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
      db.insert(projects).values({ id: "project-attach", name: "Attach Project", rootPath }).run();
      db.insert(tasks)
        .values({
          id: "upd-attach-1",
          projectId: "project-attach",
          title: "Attach task",
          attachments: JSON.stringify([]),
        })
        .run();

      const res = await app.request("/tasks/upd-attach-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachments: [{ name: "note.txt", mimeType: "text/plain", size: 5, content: "hello" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].name).toBe("note.txt");
      expect(body.attachments[0].path).toBeDefined();
    });

    it("should sync physical plan file when updating plan via PUT", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-put-plan-sync-"));
      db.insert(projects)
        .values({
          id: "project-put-plan",
          name: "Project Put Plan",
          rootPath,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "upd-plan-1",
          projectId: "project-put-plan",
          title: "Update plan",
          isFix: false,
        })
        .run();

      const res = await app.request("/tasks/upd-plan-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "## PUT Plan\n- [ ] Step from API" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plan).toBe("## PUT Plan\n- [ ] Step from API");

      const filePlan = readFileSync(join(rootPath, ".ai-factory", "PLAN.md"), "utf8");
      expect(filePlan).toBe("## PUT Plan\n- [ ] Step from API\n");
    });
  });

  describe("POST /tasks/:id/sync-plan", () => {
    it("should sync db plan from physical PLAN.md", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-sync-plan-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      writeFileSync(join(aiFactoryDir, "PLAN.md"), "## Synced Plan\n- Step from file\n", "utf8");

      db.insert(projects)
        .values({
          id: "project-sync",
          name: "Project Sync",
          rootPath,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "task-sync",
          projectId: "project-sync",
          title: "Sync task",
          plan: "## Old Plan\n- old step",
        })
        .run();

      const res = await app.request("/tasks/task-sync/sync-plan", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plan).toBe("## Synced Plan\n- Step from file\n");
    });

    it("should return 404 when physical plan file is missing", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-sync-plan-missing-"));
      mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });

      db.insert(projects)
        .values({
          id: "project-sync-missing",
          name: "Project Sync Missing",
          rootPath,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "task-sync-missing",
          projectId: "project-sync-missing",
          title: "Sync task missing",
        })
        .run();

      const res = await app.request("/tasks/task-sync-missing/sync-plan", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Plan file not found/);
    });

    it("should return 404 when project for task does not exist", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "task-sync-no-project",
          projectId: "missing-project",
          title: "Task without project",
        })
        .run();

      const res = await app.request("/tasks/task-sync-no-project/sync-plan", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Task or project not found/);
    });
  });

  describe("POST /tasks/:id/sync-plan — edge cases", () => {
    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/totally-missing/sync-plan", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("should sync empty plan file as null plan", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-sync-empty-plan-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      writeFileSync(join(aiFactoryDir, "PLAN.md"), "   \n  \n", "utf8");

      db.insert(projects)
        .values({ id: "project-sync-empty", name: "Empty Plan Sync", rootPath })
        .run();
      db.insert(tasks)
        .values({
          id: "task-sync-empty",
          projectId: "project-sync-empty",
          title: "Sync empty plan",
          plan: "## Old Plan",
        })
        .run();

      const res = await app.request("/tasks/task-sync-empty/sync-plan", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plan).toBeNull();
    });
  });

  describe("GET /tasks/:id/plan-file-status — edge cases", () => {
    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/totally-missing/plan-file-status");
      expect(res.status).toBe(404);
    });

    it("should return 404 when project for task does not exist", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "task-pfs-no-project",
          projectId: "missing-project",
          title: "No project",
        })
        .run();

      const res = await app.request("/tasks/task-pfs-no-project/plan-file-status");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /tasks/:id/plan-file-status", () => {
    it("should report existing canonical plan file", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-plan-status-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      writeFileSync(join(aiFactoryDir, "PLAN.md"), "## Existing Plan\n", "utf8");

      db.insert(projects)
        .values({
          id: "project-plan-status",
          name: "Project Plan Status",
          rootPath,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "task-plan-status",
          projectId: "project-plan-status",
          title: "Status task",
        })
        .run();

      const res = await app.request("/tasks/task-plan-status/plan-file-status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(true);
      const normalizedPath = String(body.path).replaceAll("\\", "/");
      expect(normalizedPath).toContain(".ai-factory/PLAN.md");
    });

    it("should report missing canonical plan file", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-plan-status-missing-"));
      mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });

      db.insert(projects)
        .values({
          id: "project-plan-status-missing",
          name: "Project Plan Status Missing",
          rootPath,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "task-plan-status-missing",
          projectId: "project-plan-status-missing",
          title: "Status task missing",
        })
        .run();

      const res = await app.request("/tasks/task-plan-status-missing/plan-file-status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(false);
      const normalizedPath = String(body.path).replaceAll("\\", "/");
      expect(normalizedPath).toContain(".ai-factory/PLAN.md");
    });
  });

  describe("DELETE /tasks/:id", () => {
    it("should delete a task", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "del-1", projectId: "test-project", title: "Delete me" }).run();

      const res = await app.request("/tasks/del-1", { method: "DELETE" });
      expect(res.status).toBe(200);

      const check = db.select().from(tasks).where(eq(tasks.id, "del-1")).get();
      expect(check).toBeUndefined();
    });

    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/non-existent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /tasks/:id/events", () => {
    it("should return 404 for events on non-existent task", async () => {
      const res = await app.request("/tasks/missing/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "start_ai" }),
      });

      expect(res.status).toBe(404);
    });

    it("should return 500 when fast_fix second attempt throws unexpectedly", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-err",
          projectId: "project-fast-fix-err",
          title: "Fast fix error path",
          status: "plan_ready",
          autoMode: false,
          plan: "## Plan\n- Step A",
        })
        .run();
      db.insert(taskComments)
        .values({
          id: "ev-fast-fix-err-comment",
          taskId: "ev-fast-fix-err",
          author: "human",
          message: "Please amend plan",
          attachments: "[]",
        })
        .run();
      db.insert(projects)
        .values({
          id: "project-fast-fix-err",
          name: "Fast fix error project",
          rootPath: process.cwd(),
        })
        .run();

      mockQuery.mockReset();
      mockQuery
        .mockImplementationOnce(async function* () {
          yield { type: "result", subtype: "error", result: "first attempt failed" };
        })
        .mockImplementationOnce(async function* () {
          yield { type: "result", subtype: "error", result: "second attempt failed" };
        });

      const res = await app.request("/tasks/ev-fast-fix-err/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal server error");
    });

    it("should start AI from backlog", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "mov-1", projectId: "test-project", title: "Move me", status: "backlog" })
        .run();

      const res = await app.request("/tasks/mov-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "start_ai" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("planning");
    });

    it("should reject invalid event payload", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "mov-2", projectId: "test-project", title: "Invalid move" })
        .run();

      const res = await app.request("/tasks/mov-2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "invalid_event" }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject invalid transition", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "mov-3",
          projectId: "test-project",
          title: "Invalid transition",
          status: "planning",
        })
        .run();

      const res = await app.request("/tasks/mov-3/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done" }),
      });

      expect(res.status).toBe(409);
    });

    it("should start implementation from plan_ready when autoMode=false", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-plan-1",
          projectId: "test-project",
          title: "Manual plan gate",
          status: "plan_ready",
          autoMode: false,
        })
        .run();

      const res = await app.request("/tasks/ev-plan-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "start_implementation" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("implementing");
    });

    it("should reject start_implementation when autoMode=true", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-plan-2",
          projectId: "test-project",
          title: "Auto plan",
          status: "plan_ready",
          autoMode: true,
        })
        .run();

      const res = await app.request("/tasks/ev-plan-2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "start_implementation" }),
      });

      expect(res.status).toBe(409);
    });

    it("should approve done task to verified", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "ev-1", projectId: "test-project", title: "Done task", status: "done" })
        .run();

      const res = await app.request("/tasks/ev-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("verified");
    });

    it("should delete PLAN.md on approve_done when deletePlanFile=true", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-approve-delete-plan-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      const planFilePath = join(aiFactoryDir, "PLAN.md");
      writeFileSync(planFilePath, "## Plan\n- [ ] Step\n", "utf8");

      db.insert(projects)
        .values({ id: "project-approve-plan", name: "Approve Plan", rootPath })
        .run();
      db.insert(tasks)
        .values({
          id: "ev-approve-plan-1",
          projectId: "project-approve-plan",
          title: "Done task with plan file",
          status: "done",
          isFix: false,
          planPath: ".ai-factory/PLAN.md",
        })
        .run();

      const res = await app.request("/tasks/ev-approve-plan-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done", deletePlanFile: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("verified");
      expect(existsSync(planFilePath)).toBe(false);
    });

    it("should approve done without deleting plan file when deletePlanFile is not set", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-approve-no-delete-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      const planFilePath = join(aiFactoryDir, "PLAN.md");
      writeFileSync(planFilePath, "## Plan\n- [ ] Keep\n", "utf8");

      db.insert(projects)
        .values({ id: "project-approve-keep", name: "Approve Keep", rootPath })
        .run();
      db.insert(tasks)
        .values({
          id: "ev-approve-keep-1",
          projectId: "project-approve-keep",
          title: "Done task keep plan",
          status: "done",
        })
        .run();

      const res = await app.request("/tasks/ev-approve-keep-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done" }),
      });

      expect(res.status).toBe(200);
      expect(existsSync(planFilePath)).toBe(true);
    });

    it("should handle approve_done with deletePlanFile when plan file does not exist", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-approve-no-file-"));
      mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });

      db.insert(projects)
        .values({ id: "project-approve-nofile", name: "Approve No File", rootPath })
        .run();
      db.insert(tasks)
        .values({
          id: "ev-approve-nofile-1",
          projectId: "project-approve-nofile",
          title: "Done task no plan file",
          status: "done",
          isFix: false,
          planPath: ".ai-factory/PLAN.md",
        })
        .run();

      const res = await app.request("/tasks/ev-approve-nofile-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done", deletePlanFile: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("verified");
    });

    it("should delete FIX_PLAN.md on approve_done when task isFix=true", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-approve-delete-fix-plan-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      const planFilePath = join(aiFactoryDir, "PLAN.md");
      const fixPlanFilePath = join(aiFactoryDir, "FIX_PLAN.md");
      writeFileSync(planFilePath, "## Plan\n- [ ] Keep this\n", "utf8");
      writeFileSync(fixPlanFilePath, "## Fix Plan\n- [ ] Remove this\n", "utf8");

      db.insert(projects)
        .values({ id: "project-approve-fix-plan", name: "Approve Fix Plan", rootPath })
        .run();
      db.insert(tasks)
        .values({
          id: "ev-approve-fix-plan-1",
          projectId: "project-approve-fix-plan",
          title: "Done fix task with fix plan file",
          status: "done",
          isFix: true,
          planPath: ".ai-factory/PLAN.md",
        })
        .run();

      const res = await app.request("/tasks/ev-approve-fix-plan-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done", deletePlanFile: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("verified");
      expect(existsSync(fixPlanFilePath)).toBe(false);
      expect(existsSync(planFilePath)).toBe(true);
    });

    it("should send done task to implementing with rework flag on request_changes", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-2",
          projectId: "test-project",
          title: "Done task",
          status: "done",
          retryCount: 2,
        })
        .run();

      const res = await app.request("/tasks/ev-2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "request_changes" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("implementing");
      expect(body.reworkRequested).toBe(true);
      expect(body.retryCount).toBe(0);
      expect(body.lastHeartbeatAt).toBeTruthy();
    });

    it("should send plan_ready task back to planning on request_replanning", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-plan-replan-1",
          projectId: "test-project",
          title: "Need replanning",
          status: "plan_ready",
          autoMode: false,
        })
        .run();

      const res = await app.request("/tasks/ev-plan-replan-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "request_replanning" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("planning");
    });

    it("should retry blocked task to blockedFromStatus", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-3",
          projectId: "test-project",
          title: "Blocked task",
          status: "blocked_external",
          blockedFromStatus: "implementing",
          blockedReason: "rate limit",
        })
        .run();

      const res = await app.request("/tasks/ev-3/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "retry_from_blocked" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("implementing");
      expect(body.blockedFromStatus).toBeNull();
      expect(body.blockedReason).toBeNull();
      expect(body.retryAfter).toBeNull();
    });

    it("should reject retry_from_blocked without blockedFromStatus", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-4",
          projectId: "test-project",
          title: "Blocked task",
          status: "blocked_external",
        })
        .run();

      const res = await app.request("/tasks/ev-4/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "retry_from_blocked" }),
      });

      expect(res.status).toBe(409);
    });

    it("should apply fast_fix by updating plan without status transition", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-1",
          projectId: "project-fast-fix",
          title: "Need tiny plan update",
          status: "plan_ready",
          autoMode: false,
          plan: "## Plan\n- Step A",
        })
        .run();
      db.insert(taskComments)
        .values({
          id: "ev-fast-fix-comment-1",
          taskId: "ev-fast-fix-1",
          author: "human",
          message: "Please add one QA step",
          attachments: "[]",
        })
        .run();
      db.insert(projects)
        .values({
          id: "project-fast-fix",
          name: "Fast fix project",
          rootPath: process.cwd(),
        })
        .run();

      const res = await app.request("/tasks/ev-fast-fix-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan_ready");
      expect(body.plan).toBe("## Updated plan\n- Fast fix applied");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("should reject fast_fix when task has no plan", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-no-plan",
          projectId: "project-fast-fix",
          title: "No plan task",
          status: "plan_ready",
          autoMode: false,
          plan: null,
        })
        .run();
      db.insert(taskComments)
        .values({
          id: "ev-ff-no-plan-comment",
          taskId: "ev-fast-fix-no-plan",
          author: "human",
          message: "fix it",
          attachments: "[]",
        })
        .run();
      db.insert(projects)
        .values({ id: "project-fast-fix", name: "FF project", rootPath: process.cwd() })
        .onConflictDoNothing()
        .run();

      const res = await app.request("/tasks/ev-fast-fix-no-plan/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/existing plan/);
    });

    it("should reject fast_fix when task has no human comment", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-no-comment",
          projectId: "test-project",
          title: "No comment task",
          status: "plan_ready",
          autoMode: false,
          plan: "## Plan\n- Step",
        })
        .run();

      const res = await app.request("/tasks/ev-fast-fix-no-comment/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/human comment/);
    });

    it("should reject fast_fix when task is not in plan_ready", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-wrong-status",
          projectId: "test-project",
          title: "Wrong status",
          status: "backlog",
          autoMode: false,
          plan: "## Plan",
        })
        .run();

      const res = await app.request("/tasks/ev-fast-fix-wrong-status/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/plan_ready/);
    });

    it("should reject fast_fix for autoMode=true", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "ev-fast-fix-2",
          projectId: "test-project",
          title: "Auto mode task",
          status: "plan_ready",
          autoMode: true,
        })
        .run();

      const res = await app.request("/tasks/ev-fast-fix-2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "fast_fix" }),
      });

      expect(res.status).toBe(409);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /tasks/:id/position", () => {
    it("should reorder a task", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "pos-1", projectId: "test-project", title: "Reorder me", position: 1000 })
        .run();

      const res = await app.request("/tasks/pos-1/position", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: 1500.5 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.position).toBe(1500.5);
    });

    it("should return 404 for reorder on non-existent task", async () => {
      const res = await app.request("/tasks/pos-missing/position", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: 1234 }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("comments", () => {
    it("should return 404 for listing comments on non-existent task", async () => {
      const res = await app.request("/tasks/nope/comments");
      expect(res.status).toBe(404);
    });

    it("should return 404 for creating comments on non-existent task", async () => {
      const res = await app.request("/tasks/nope/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "comment" }),
      });

      expect(res.status).toBe(404);
    });

    it("should create and list task comments with attachments", async () => {
      const db = testDb.current;
      insertTestProject(db);
      db.insert(tasks)
        .values({ id: "c-1", projectId: "test-project", title: "Comment target" })
        .run();

      const createRes = await app.request("/tasks/c-1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please update the API section in the plan",
          attachments: [
            {
              name: "notes.md",
              mimeType: "text/markdown",
              size: 20,
              content: "Use OpenAPI-first approach",
            },
          ],
        }),
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.message).toBe("Please update the API section in the plan");
      expect(created.attachments).toHaveLength(1);

      const listRes = await app.request("/tasks/c-1/comments");
      expect(listRes.status).toBe(200);
      const listed = await listRes.json();
      expect(listed).toHaveLength(1);
      expect(listed[0].attachments[0].name).toBe("notes.md");
    });

    it("should delete task comments when deleting a task", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "c-2", projectId: "test-project", title: "Delete cascade" })
        .run();
      db.insert(taskComments)
        .values({
          id: "comment-1",
          taskId: "c-2",
          author: "human",
          message: "comment",
          attachments: "[]",
        })
        .run();

      const delRes = await app.request("/tasks/c-2", { method: "DELETE" });
      expect(delRes.status).toBe(200);

      const comments = db.select().from(taskComments).where(eq(taskComments.taskId, "c-2")).all();
      expect(comments).toHaveLength(0);
    });
  });

  describe("GET /tasks/:id/attachments/:filename", () => {
    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/no-task/attachments/file.txt");
      expect(res.status).toBe(404);
    });

    it("should return 404 when attachment not found on task", async () => {
      const db = testDb.current;
      insertTestProject(db);
      db.insert(tasks)
        .values({
          id: "dl-1",
          projectId: "test-project",
          title: "Download test",
          attachments: JSON.stringify([
            {
              name: "readme.md",
              mimeType: "text/markdown",
              size: 10,
              content: null,
              path: ".ai-factory/files/tasks/dl-1/readme.md",
            },
          ]),
        })
        .run();

      const res = await app.request("/tasks/dl-1/attachments/missing.txt");
      expect(res.status).toBe(404);
    });

    it("should download file-backed attachment", async () => {
      const db = testDb.current;
      insertTestProject(db);
      const fileContent = Buffer.from("# Hello World");
      db.insert(tasks)
        .values({
          id: "dl-2",
          projectId: "test-project",
          title: "Download test",
          attachments: JSON.stringify([
            {
              name: "readme.md",
              mimeType: "text/markdown",
              size: fileContent.length,
              content: null,
              path: ".ai-factory/files/tasks/dl-2/readme.md",
            },
          ]),
        })
        .run();

      mockReadAttachment.mockResolvedValue(fileContent);

      const res = await app.request("/tasks/dl-2/attachments/readme.md");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/markdown");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="readme.md"');
      const body = await res.arrayBuffer();
      expect(Buffer.from(body).toString()).toBe("# Hello World");
    });

    it("should return 404 when file missing from disk", async () => {
      const db = testDb.current;
      insertTestProject(db);
      db.insert(tasks)
        .values({
          id: "dl-3",
          projectId: "test-project",
          title: "Download test",
          attachments: JSON.stringify([
            {
              name: "gone.txt",
              mimeType: "text/plain",
              size: 5,
              content: null,
              path: ".ai-factory/files/tasks/dl-3/gone.txt",
            },
          ]),
        })
        .run();

      mockReadAttachment.mockRejectedValue(new Error("ENOENT"));

      const res = await app.request("/tasks/dl-3/attachments/gone.txt");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /tasks/:id — plan update error path", () => {
    it("should return 404 when plan update fails due to missing project", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "upd-plan-no-proj",
          projectId: "missing-project",
          title: "Plan update no project",
        })
        .run();

      const res = await app.request("/tasks/upd-plan-no-proj", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "## New plan" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Project not found/);
    });
  });

  describe("comments — no attachments path", () => {
    it("should create comment without attachments", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "c-no-att", projectId: "test-project", title: "No attachment comment" })
        .run();

      const res = await app.request("/tasks/c-no-att/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "plain comment" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.message).toBe("plain comment");
      expect(body.attachments).toHaveLength(0);
    });

    it("should create comment with empty attachments array", async () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({ id: "c-empty-att", projectId: "test-project", title: "Empty attachment comment" })
        .run();

      const res = await app.request("/tasks/c-empty-att/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "comment with empty attachments", attachments: [] }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.message).toBe("comment with empty attachments");
    });
  });

  describe("GET /tasks/:id/comments/:commentId/attachments/:filename", () => {
    it("should return 404 for non-existent comment", async () => {
      const db = testDb.current;
      insertTestProject(db);
      db.insert(tasks).values({ id: "cdl-1", projectId: "test-project", title: "T" }).run();

      const res = await app.request("/tasks/cdl-1/comments/no-comment/attachments/file.txt");
      expect(res.status).toBe(404);
    });

    it("should download comment attachment", async () => {
      const db = testDb.current;
      insertTestProject(db);
      db.insert(tasks).values({ id: "cdl-2", projectId: "test-project", title: "T" }).run();
      const fileContent = Buffer.from("comment file data");
      db.insert(taskComments)
        .values({
          id: "cm-1",
          taskId: "cdl-2",
          author: "human",
          message: "see attached",
          attachments: JSON.stringify([
            {
              name: "notes.md",
              mimeType: "text/markdown",
              size: fileContent.length,
              content: null,
              path: ".ai-factory/files/tasks/cdl-2/comments/cm-1/notes.md",
            },
          ]),
        })
        .run();

      mockReadAttachment.mockResolvedValue(fileContent);

      const res = await app.request("/tasks/cdl-2/comments/cm-1/attachments/notes.md");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/markdown");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="notes.md"');
      const body = await res.arrayBuffer();
      expect(Buffer.from(body).toString()).toBe("comment file data");
    });
  });

  describe("GET /settings", () => {
    it("should return useSubagents from env", async () => {
      const settingsApp = createAppWithSettings();
      const res = await settingsApp.request("/settings");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.useSubagents).toBe("boolean");
    });
  });
});
