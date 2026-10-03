import { describe, it, expect, beforeEach, vi } from "vitest";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  createTask,
  updateTask,
  findCoordinatorTaskCandidate,
  toTaskResponse,
  listDueBlockedExternalTasks,
  listStaleInProgressTasks,
} = await import("../index.js");

function insertTestProject(db: ReturnType<typeof createTestDb>) {
  db.insert(projects).values({ id: "test-project", name: "Test", rootPath: "/tmp/test" }).run();
}

describe("pause functionality", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    insertTestProject(testDb.current);
  });

  describe("createTask", () => {
    it("should default paused to false", () => {
      const task = createTask({
        projectId: "test-project",
        title: "Test task",
        description: "desc",
      });
      expect(task).toBeDefined();
      expect(task!.paused).toBe(false);
    });

    it("should accept paused=true on create", () => {
      const task = createTask({
        projectId: "test-project",
        title: "Paused task",
        description: "desc",
        paused: true,
      });
      expect(task).toBeDefined();
      expect(task!.paused).toBe(true);
    });
  });

  describe("updateTask", () => {
    it("should update paused to true", () => {
      const task = createTask({
        projectId: "test-project",
        title: "Task to pause",
        description: "desc",
      });
      const updated = updateTask(task!.id, { paused: true });
      expect(updated).toBeDefined();
      expect(updated!.paused).toBe(true);
    });

    it("should update paused back to false", () => {
      const task = createTask({
        projectId: "test-project",
        title: "Task to resume",
        description: "desc",
        paused: true,
      });
      const updated = updateTask(task!.id, { paused: false });
      expect(updated).toBeDefined();
      expect(updated!.paused).toBe(false);
    });
  });

  describe("findCoordinatorTaskCandidate", () => {
    it("should skip paused tasks in planning stage", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-planning",
          projectId: "test-project",
          title: "Paused planning",
          status: "planning",
          paused: true,
        })
        .run();

      const candidate = findCoordinatorTaskCandidate("planner");
      expect(candidate).toBeUndefined();
    });

    it("should return non-paused tasks in planning stage", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "active-planning",
          projectId: "test-project",
          title: "Active planning",
          status: "planning",
          paused: false,
        })
        .run();

      const candidate = findCoordinatorTaskCandidate("planner");
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe("active-planning");
    });

    it("should skip paused tasks in implementer stage", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-impl",
          projectId: "test-project",
          title: "Paused implementing",
          status: "implementing",
          paused: true,
        })
        .run();

      const candidate = findCoordinatorTaskCandidate("implementer");
      expect(candidate).toBeUndefined();
    });

    it("should skip paused tasks in review stage", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-review",
          projectId: "test-project",
          title: "Paused review",
          status: "review",
          paused: true,
        })
        .run();

      const candidate = findCoordinatorTaskCandidate("reviewer");
      expect(candidate).toBeUndefined();
    });

    it("should pick non-paused task when paused and non-paused both exist", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-one",
          projectId: "test-project",
          title: "Paused",
          status: "planning",
          paused: true,
          position: 1,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "active-one",
          projectId: "test-project",
          title: "Active",
          status: "planning",
          paused: false,
          position: 2,
        })
        .run();

      const candidate = findCoordinatorTaskCandidate("planner");
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe("active-one");
    });
  });

  describe("listDueBlockedExternalTasks", () => {
    it("should skip paused blocked tasks", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-blocked",
          projectId: "test-project",
          title: "Paused blocked",
          status: "blocked_external",
          paused: true,
          retryAfter: "2020-01-01T00:00:00Z",
          blockedFromStatus: "planning",
        })
        .run();

      const result = listDueBlockedExternalTasks(new Date().toISOString());
      expect(result).toHaveLength(0);
    });

    it("should return non-paused blocked tasks", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "active-blocked",
          projectId: "test-project",
          title: "Active blocked",
          status: "blocked_external",
          paused: false,
          retryAfter: "2020-01-01T00:00:00Z",
          blockedFromStatus: "planning",
        })
        .run();

      const result = listDueBlockedExternalTasks(new Date().toISOString());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("active-blocked");
    });
  });

  describe("listStaleInProgressTasks", () => {
    it("should skip paused in-progress tasks", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "paused-in-progress",
          projectId: "test-project",
          title: "Paused planning",
          status: "planning",
          stageStartedAt: new Date().toISOString(),
          paused: true,
        })
        .run();

      const result = listStaleInProgressTasks();
      expect(result).toHaveLength(0);
    });

    it("should return non-paused in-progress tasks", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "active-in-progress",
          projectId: "test-project",
          title: "Active implementing",
          status: "implementing",
          stageStartedAt: new Date().toISOString(),
          paused: false,
        })
        .run();

      const result = listStaleInProgressTasks();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("active-in-progress");
    });
  });

  describe("toTaskResponse", () => {
    it("should include paused field in response", () => {
      const task = createTask({
        projectId: "test-project",
        title: "Response test",
        description: "desc",
        paused: true,
      });
      const response = toTaskResponse(task!);
      expect(response.paused).toBe(true);
    });
  });
});
