import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects } from "@aif/shared";

// Set up test DB before importing tools
const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Mock env to avoid shared env validation
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

const {
  createTask,
  findTaskById,
  listTasks,
  listProjects,
  searchTasks,
  toTaskResponse,
  touchLastSyncedAt,
  updateTaskStatus,
  setTaskFields,
  listTasksPaginated,
  searchTasksPaginated,
  toTaskSummary,
} = await import("@aif/data");

const { resolveConflict } = await import("../sync/conflictResolver.js");
const { compactTaskResponse } = await import("../utils/compactResponse.js");

function seedProject(id = "proj-1") {
  testDb.current.insert(projects).values({ id, name: "Test", rootPath: "/tmp/test" }).run();
}

function seedTask(overrides: { projectId?: string; title?: string; description?: string } = {}) {
  return createTask({
    projectId: overrides.projectId ?? "proj-1",
    title: overrides.title ?? "Test Task",
    description: overrides.description ?? "Description",
  });
}

describe("MCP tools", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
  });

  // ── listTasks ─────────────────────────────────────────────

  describe("listTasks data layer", () => {
    it("lists all tasks", () => {
      seedTask({ title: "A" });
      seedTask({ title: "B" });
      const all = listTasks("proj-1");
      expect(all).toHaveLength(2);
    });

    it("filters by project", () => {
      testDb.current
        .insert(projects)
        .values({ id: "proj-2", name: "Other", rootPath: "/tmp/other" })
        .run();
      seedTask({ projectId: "proj-1", title: "P1 Task" });
      seedTask({ projectId: "proj-2", title: "P2 Task" });
      expect(listTasks("proj-1")).toHaveLength(1);
      expect(listTasks("proj-2")).toHaveLength(1);
    });
  });

  // ── listTasksPaginated ─────────────────────────────────────

  describe("listTasksPaginated", () => {
    it("returns paginated results with total count", () => {
      for (let i = 0; i < 5; i++) seedTask({ title: `Paged ${i}` });
      const result = listTasksPaginated({ limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.limit).toBe(2);
    });

    it("excludes heavy fields from summary", () => {
      seedTask({ title: "Summary check", description: "big description" });
      const result = listTasksPaginated({});
      const item = result.items[0];
      expect(item).toHaveProperty("title");
      expect(item).not.toHaveProperty("plan");
      expect(item).not.toHaveProperty("description");
      expect(item).not.toHaveProperty("implementationLog");
    });

    it("toTaskSummary parses tags", () => {
      createTask({ projectId: "proj-1", title: "T", description: "", tags: ["x"] });
      const result = listTasksPaginated({});
      const summary = toTaskSummary(result.items[0]);
      expect(summary.tags).toContain("x");
    });
  });

  // ── searchTasksPaginated ──────────────────────────────────

  describe("searchTasksPaginated", () => {
    it("returns paginated search results", () => {
      for (let i = 0; i < 5; i++) seedTask({ title: `Findable ${i}` });
      const result = searchTasksPaginated({ query: "Findable", limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
    });
  });

  // ── getTask ───────────────────────────────────────────────

  describe("getTask data layer", () => {
    it("finds task by ID", () => {
      const task = seedTask();
      const found = findTaskById(task!.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Test Task");
    });

    it("returns undefined for missing task", () => {
      expect(findTaskById("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    });
  });

  // ── searchTasks ───────────────────────────────────────────

  describe("searchTasks data layer", () => {
    it("searches by title", () => {
      seedTask({ title: "Authentication feature" });
      seedTask({ title: "Database migration" });
      const results = searchTasks("Auth");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Authentication feature");
    });

    it("returns empty for no matches", () => {
      seedTask({ title: "Something" });
      expect(searchTasks("nonexistent")).toHaveLength(0);
    });
  });

  // ── listProjects ──────────────────────────────────────────

  describe("listProjects data layer", () => {
    it("lists all projects", () => {
      const all = listProjects();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("Test");
    });
  });

  // ── createTask ────────────────────────────────────────────

  describe("createTask data layer", () => {
    it("creates a task", () => {
      const task = seedTask({ title: "New Task" });
      expect(task).toBeDefined();
      expect(task!.title).toBe("New Task");
      expect(task!.status).toBe("backlog");
    });

    it("creates with optional fields", () => {
      const task = createTask({
        projectId: "proj-1",
        title: "Tagged",
        description: "Desc",
        priority: 2,
        tags: ["urgent"],
      });
      expect(task).toBeDefined();
      expect(task!.priority).toBe(2);
    });
  });

  // ── syncStatus conflict resolver ──────────────────────────

  describe("conflictResolver", () => {
    it("source wins when newer", () => {
      const result = resolveConflict({
        sourceTimestamp: "2026-01-02T00:00:00.000Z",
        targetTimestamp: "2026-01-01T00:00:00.000Z",
        field: "status",
      });
      expect(result.applied).toBe(true);
      expect(result.conflict).toBe(false);
      expect(result.winner).toBe("source");
    });

    it("target wins when newer", () => {
      const result = resolveConflict({
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        targetTimestamp: "2026-01-02T00:00:00.000Z",
        field: "status",
      });
      expect(result.applied).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.winner).toBe("target");
    });

    it("source wins on equal timestamps", () => {
      const result = resolveConflict({
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        targetTimestamp: "2026-01-01T00:00:00.000Z",
        field: "status",
      });
      expect(result.applied).toBe(true);
      expect(result.conflict).toBe(false);
    });
  });

  // ── syncStatus flow ───────────────────────────────────────

  describe("syncStatus flow", () => {
    it("applies status change when source is newer", () => {
      const task = seedTask();
      expect(task!.status).toBe("backlog");

      // Set updatedAt to old time
      setTaskFields(task!.id, { updatedAt: "2026-01-01T00:00:00.000Z" });

      const resolution = resolveConflict({
        sourceTimestamp: "2026-01-02T00:00:00.000Z",
        targetTimestamp: "2026-01-01T00:00:00.000Z",
        field: "status",
      });
      expect(resolution.applied).toBe(true);

      updateTaskStatus(task!.id, "planning");
      touchLastSyncedAt(task!.id);

      const updated = findTaskById(task!.id);
      expect(updated!.status).toBe("planning");
      expect(updated!.lastSyncedAt).toBeTruthy();
    });

    it("detects conflict when target is newer", () => {
      const task = seedTask();
      setTaskFields(task!.id, { updatedAt: "2026-01-02T00:00:00.000Z" });

      const resolution = resolveConflict({
        sourceTimestamp: "2026-01-01T00:00:00.000Z",
        targetTimestamp: "2026-01-02T00:00:00.000Z",
        field: "status",
      });
      expect(resolution.conflict).toBe(true);
      expect(resolution.applied).toBe(false);
    });
  });

  // ── pushPlan flow ─────────────────────────────────────────

  describe("pushPlan flow", () => {
    it("updates task plan field", () => {
      const task = seedTask();
      const planContent = "## Plan\n- Step 1\n- Step 2";

      setTaskFields(task!.id, { plan: planContent, updatedAt: new Date().toISOString() });
      const updated = findTaskById(task!.id);
      expect(updated!.plan).toBe(planContent);
    });

    it("preserves annotations in plan content", () => {
      const task = seedTask();
      const planContent = `## Overview\n<!-- handoff:task:${task!.id} -->\nContent here`;

      setTaskFields(task!.id, { plan: planContent, updatedAt: new Date().toISOString() });
      const updated = findTaskById(task!.id);
      expect(updated!.plan).toContain("handoff:task:");
    });
  });

  // ── toTaskResponse ────────────────────────────────────────

  describe("toTaskResponse", () => {
    it("converts TaskRow to Task with parsed fields", () => {
      const row = seedTask();
      const task = toTaskResponse(row!);
      expect(task.id).toBe(row!.id);
      expect(Array.isArray(task.tags)).toBe(true);
      expect(task.lastSyncedAt).toBeNull();
    });
  });

  // ── compactTaskResponse ────────────────────────────────────

  describe("compactTaskResponse", () => {
    it("strips plan, implementationLog, reviewComments", () => {
      const task = seedTask();
      setTaskFields(task!.id, {
        plan: "## Big Plan\n".repeat(100),
        implementationLog: "log line\n".repeat(50),
        reviewComments: "comment\n".repeat(50),
      });
      const row = findTaskById(task!.id);
      const full = toTaskResponse(row!);
      const compact = compactTaskResponse(full);

      expect(compact).not.toHaveProperty("plan");
      expect(compact).not.toHaveProperty("implementationLog");
      expect(compact).not.toHaveProperty("reviewComments");
      expect(compact.hasPlan).toBe(true);
      expect(compact.hasImplementationLog).toBe(true);
      expect(compact.hasReviewComments).toBe(true);
    });

    it("reports false flags when heavy fields are null", () => {
      const task = seedTask();
      const full = toTaskResponse(findTaskById(task!.id)!);
      const compact = compactTaskResponse(full);

      expect(compact.hasPlan).toBe(false);
      expect(compact.hasImplementationLog).toBe(false);
      expect(compact.hasReviewComments).toBe(false);
    });

    it("preserves all other fields", () => {
      const task = seedTask({ title: "Keep Fields" });
      setTaskFields(task!.id, { plan: "some plan" });
      const full = toTaskResponse(findTaskById(task!.id)!);
      const compact = compactTaskResponse(full);

      expect(compact.id).toBe(task!.id);
      expect(compact.title).toBe("Keep Fields");
      expect(compact.status).toBe("backlog");
      expect(compact.projectId).toBe("proj-1");
      expect(compact.createdAt).toBeTruthy();
      expect(compact.updatedAt).toBeTruthy();
    });

    it("compact response is significantly smaller than full", () => {
      const task = seedTask();
      setTaskFields(task!.id, {
        plan: "x".repeat(10_000),
        implementationLog: "y".repeat(5_000),
        reviewComments: "z".repeat(3_000),
      });
      const full = toTaskResponse(findTaskById(task!.id)!);
      const compact = compactTaskResponse(full);

      const fullSize = JSON.stringify(full).length;
      const compactSize = JSON.stringify(compact).length;
      expect(compactSize).toBeLessThan(fullSize * 0.1);
    });
  });

  // ── getTask field selection ───────────────────────────────

  describe("getTask field selection", () => {
    it("returns only requested fields plus id", () => {
      const task = seedTask({ title: "Field Select" });
      setTaskFields(task!.id, { plan: "big plan content" });
      const full = toTaskResponse(findTaskById(task!.id)!) as unknown as Record<string, unknown>;

      const fields = new Set(["status", "title"]);
      fields.add("id");
      const result: Record<string, unknown> = {};
      for (const key of fields) {
        if (key in full) result[key] = full[key];
      }

      expect(Object.keys(result)).toHaveLength(3);
      expect(result.id).toBe(task!.id);
      expect(result.title).toBe("Field Select");
      expect(result.status).toBe("backlog");
      expect(result).not.toHaveProperty("plan");
      expect(result).not.toHaveProperty("description");
    });

    it("always includes id even if not requested", () => {
      const task = seedTask();
      const full = toTaskResponse(findTaskById(task!.id)!) as unknown as Record<string, unknown>;

      const fields = new Set(["status"]);
      fields.add("id");
      const result: Record<string, unknown> = {};
      for (const key of fields) {
        if (key in full) result[key] = full[key];
      }

      expect(result.id).toBe(task!.id);
    });

    it("returns full task when no fields specified", () => {
      const task = seedTask();
      setTaskFields(task!.id, { plan: "plan content here" });
      const full = toTaskResponse(findTaskById(task!.id)!);

      expect(full).toHaveProperty("id");
      expect(full).toHaveProperty("plan");
      expect(full).toHaveProperty("description");
      expect(full).toHaveProperty("implementationLog");
    });

    it("can select only heavy fields", () => {
      const task = seedTask();
      setTaskFields(task!.id, {
        plan: "the plan",
        implementationLog: "the log",
      });
      const full = toTaskResponse(findTaskById(task!.id)!) as unknown as Record<string, unknown>;

      const fields = new Set(["plan", "implementationLog"]);
      fields.add("id");
      const result: Record<string, unknown> = {};
      for (const key of fields) {
        if (key in full) result[key] = full[key];
      }

      expect(result.id).toBe(task!.id);
      expect(result.plan).toBe("the plan");
      expect(result.implementationLog).toBe("the log");
      expect(result).not.toHaveProperty("title");
    });

    it("ignores unknown fields gracefully", () => {
      const task = seedTask();
      const full = toTaskResponse(findTaskById(task!.id)!) as unknown as Record<string, unknown>;

      const fields = new Set(["status", "nonExistentField"]);
      fields.add("id");
      const result: Record<string, unknown> = {};
      for (const key of fields) {
        if (key in full) result[key] = full[key];
      }

      expect(result.id).toBe(task!.id);
      expect(result.status).toBe("backlog");
      expect(result).not.toHaveProperty("nonExistentField");
    });
  });

  // ── Integration: full create → search → update → sync flow ─

  describe("integration flow", () => {
    it("create → search → update → sync status", () => {
      // 1. Create
      const task = createTask({
        projectId: "proj-1",
        title: "Integration Test Task",
        description: "Test the full flow",
        priority: 1,
      });
      expect(task).toBeDefined();

      // 2. Search
      const searchResults = searchTasks("Integration");
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0].id).toBe(task!.id);

      // 3. Update
      setTaskFields(task!.id, {
        plan: "## Plan\nDo things",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const withPlan = findTaskById(task!.id);
      expect(withPlan!.plan).toContain("Plan");

      // 4. Sync status (source newer)
      const resolution = resolveConflict({
        sourceTimestamp: "2026-01-02T00:00:00.000Z",
        targetTimestamp: withPlan!.updatedAt,
        field: "status",
      });
      expect(resolution.applied).toBe(true);

      updateTaskStatus(task!.id, "planning");
      touchLastSyncedAt(task!.id);

      const final = findTaskById(task!.id);
      expect(final!.status).toBe("planning");
      expect(final!.lastSyncedAt).toBeTruthy();
      expect(final!.plan).toContain("Plan");
    });
  });
});
