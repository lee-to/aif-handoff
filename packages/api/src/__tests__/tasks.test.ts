import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, tasks, taskComments, projects } from "@aif/shared";

// Mock the shared db module to use test db
const testDb = { current: createTestDb() };
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
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

    it("should return 404 for non-existent task", async () => {
      const res = await app.request("/tasks/non-existent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /tasks/:id/sync-plan", () => {
    it("should sync db plan from physical PLAN.md", async () => {
      const db = testDb.current;
      const rootPath = mkdtempSync(join(tmpdir(), "aif-sync-plan-"));
      const aiFactoryDir = join(rootPath, ".ai-factory");
      mkdirSync(aiFactoryDir, { recursive: true });
      writeFileSync(join(aiFactoryDir, "PLAN.md"), "## Synced Plan\n- Step from file\n", "utf8");

      db.insert(projects).values({
        id: "project-sync",
        name: "Project Sync",
        rootPath,
      }).run();
      db.insert(tasks).values({
        id: "task-sync",
        projectId: "project-sync",
        title: "Sync task",
        plan: "## Old Plan\n- old step",
      }).run();

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

      db.insert(projects).values({
        id: "project-sync-missing",
        name: "Project Sync Missing",
        rootPath,
      }).run();
      db.insert(tasks).values({
        id: "task-sync-missing",
        projectId: "project-sync-missing",
        title: "Sync task missing",
      }).run();

      const res = await app.request("/tasks/task-sync-missing/sync-plan", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Plan file not found/);
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

    it("should start AI from backlog", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "mov-1", projectId: "test-project", title: "Move me", status: "backlog" }).run();

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
      db.insert(tasks).values({ id: "mov-2", projectId: "test-project", title: "Invalid move" }).run();

      const res = await app.request("/tasks/mov-2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "invalid_event" }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject invalid transition", async () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "mov-3", projectId: "test-project", title: "Invalid transition", status: "planning" }).run();

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
      db.insert(tasks).values({ id: "ev-1", projectId: "test-project", title: "Done task", status: "done" }).run();

      const res = await app.request("/tasks/ev-1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "approve_done" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("verified");
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
      db.insert(tasks).values({ id: "pos-1", projectId: "test-project", title: "Reorder me", position: 1000 }).run();

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

      const comments = db
        .select()
        .from(taskComments)
        .where(eq(taskComments.taskId, "c-2"))
        .all();
      expect(comments).toHaveLength(0);
    });
  });
});
