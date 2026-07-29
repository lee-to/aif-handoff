import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tasks, projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { createGitTestRoot } from "./gitTestUtils.js";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Stub fetch so notifyProjectBroadcast doesn't try to hit the API.
const originalFetch = global.fetch;
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Coordinator reads env at module load. This suite covers the rollout-on
// auto-queue behavior for branch-isolated projects.
vi.stubEnv("AIF_TASK_WORKTREES_ENABLED", "true");
vi.stubEnv("AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED", "true");

const { processAutoQueueAdvance, processDueScheduledTasks } = await import("../coordinator.js");
const { createTask, findTaskById, setAutoQueueMode, updateTaskStatus, setTaskFields } =
  await import("@aif/data");

function seedProject(id: string, opts: { autoQueue?: boolean; parallel?: boolean } = {}) {
  testDb.current
    .insert(projects)
    .values({
      id,
      name: id,
      rootPath: `/tmp/${id}`,
      parallelEnabled: opts.parallel ?? false,
      autoQueueMode: opts.autoQueue ?? false,
    })
    .run();
}

function seedTask(
  id: string,
  projectId: string,
  position: number,
  extras: Partial<typeof tasks.$inferInsert> = {},
) {
  testDb.current
    .insert(tasks)
    .values({
      id,
      projectId,
      title: id,
      status: "backlog",
      position,
      ...extras,
    })
    .run();
}

describe("processAutoQueueAdvance", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("does nothing when no project has auto-queue enabled", () => {
    seedProject("p", { autoQueue: false });
    seedTask("t1", "p", 100);
    expect(processAutoQueueAdvance()).toBe(0);
    expect(findTaskById("t1")?.status).toBe("backlog");
  });

  describe("sequential project (parallelEnabled = false)", () => {
    beforeEach(() => seedProject("seq", { autoQueue: true, parallel: false }));

    it("advances one backlog task to planning when pipeline is empty", () => {
      seedTask("t1", "seq", 100);
      seedTask("t2", "seq", 200);

      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(1);
      expect(findTaskById("t1")?.status).toBe("planning");
      expect(findTaskById("t2")?.status).toBe("backlog");
    });

    it("advances ordinary created backlog tasks in FIFO order", () => {
      const a = createTask({ projectId: "seq", title: "A", description: "" });
      const b = createTask({ projectId: "seq", title: "B", description: "" });
      const c = createTask({ projectId: "seq", title: "C", description: "" });

      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById(a!.id)?.status).toBe("planning");
      expect(findTaskById(b!.id)?.status).toBe("backlog");
      expect(findTaskById(c!.id)?.status).toBe("backlog");

      updateTaskStatus(a!.id, "done");
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById(b!.id)?.status).toBe("planning");
      expect(findTaskById(c!.id)?.status).toBe("backlog");

      updateTaskStatus(b!.id, "done");
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById(c!.id)?.status).toBe("planning");
    });

    it("does NOT advance while a task is still planning/plan_ready/implementing/review", () => {
      seedTask("t1", "seq", 100, { status: "planning" });
      seedTask("t2", "seq", 200);

      expect(processAutoQueueAdvance()).toBe(0);
      expect(findTaskById("t2")?.status).toBe("backlog");

      // Advancing through stages — auto-queue stays blocked until terminal
      for (const stage of ["plan_ready", "implementing", "review"] as const) {
        updateTaskStatus("t1", stage);
        expect(processAutoQueueAdvance()).toBe(0);
        expect(findTaskById("t2")?.status).toBe("backlog");
      }
    });

    it("advances next task only after previous reaches done", () => {
      seedTask("t1", "seq", 100, { status: "review" });
      seedTask("t2", "seq", 200);

      expect(processAutoQueueAdvance()).toBe(0);
      updateTaskStatus("t1", "done");
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t2")?.status).toBe("planning");
    });

    it("treats verified the same as done (terminal)", () => {
      seedTask("t1", "seq", 100, { status: "verified" });
      seedTask("t2", "seq", 200);
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t2")?.status).toBe("planning");
    });

    it("treats blocked_external as still in flight (does not advance)", () => {
      seedTask("t1", "seq", 100, { status: "blocked_external" });
      seedTask("t2", "seq", 200);
      expect(processAutoQueueAdvance()).toBe(0);
      expect(findTaskById("t2")?.status).toBe("backlog");
    });

    it("skips paused backlog tasks and picks the next unpaused one", () => {
      seedTask("t1", "seq", 100, { paused: true });
      seedTask("t2", "seq", 200);
      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(1);
      expect(findTaskById("t1")?.status).toBe("backlog");
      expect(findTaskById("t1")?.paused).toBe(true);
      expect(findTaskById("t2")?.status).toBe("planning");
    });

    it("skips backlog tasks with future scheduledAt — those belong to scheduler", () => {
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      seedTask("t1", "seq", 100, { scheduledAt: future });
      seedTask("t2", "seq", 200);
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t1")?.scheduledAt).toBe(future);
      expect(findTaskById("t2")?.status).toBe("planning");
    });

    it("clears scheduledAt and broadcasts when advancing", () => {
      seedTask("t1", "seq", 100);
      processAutoQueueAdvance();
      expect(findTaskById("t1")?.scheduledAt).toBeNull();
      const broadcastCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/broadcast"),
      );
      expect(broadcastCall).toBeDefined();
    });
  });

  describe("parallel project (synergy with parallelEnabled = true)", () => {
    beforeEach(() => seedProject("par", { autoQueue: true, parallel: true }));

    it("fills the pool up to the per-project concurrency cap in a single tick", () => {
      // Default COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT = 3
      seedTask("t1", "par", 100);
      seedTask("t2", "par", 200);
      seedTask("t3", "par", 300);
      seedTask("t4", "par", 400);

      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(3);
      expect(findTaskById("t1")?.status).toBe("planning");
      expect(findTaskById("t2")?.status).toBe("planning");
      expect(findTaskById("t3")?.status).toBe("planning");
      expect(findTaskById("t4")?.status).toBe("backlog");
    });

    it("refills only what's needed when one task remains in flight", () => {
      seedTask("active", "par", 100, { status: "implementing" });
      seedTask("t2", "par", 200);
      seedTask("t3", "par", 300);
      seedTask("t4", "par", 400);

      const advanced = processAutoQueueAdvance();
      // active counts toward limit (3), so only 2 more advance
      expect(advanced).toBe(2);
      expect(findTaskById("t2")?.status).toBe("planning");
      expect(findTaskById("t3")?.status).toBe("planning");
      expect(findTaskById("t4")?.status).toBe("backlog");
    });

    it("does not advance when pool is at capacity", () => {
      seedTask("t1", "par", 100, { status: "planning" });
      seedTask("t2", "par", 200, { status: "implementing" });
      seedTask("t3", "par", 300, { status: "review" });
      seedTask("t4", "par", 400);

      expect(processAutoQueueAdvance()).toBe(0);
      expect(findTaskById("t4")?.status).toBe("backlog");
    });

    it("does not refill the pool while a task has a failed commit gate", () => {
      seedTask("failed", "par", 100, {
        status: "blocked_external",
        autoQueueCommitStatus: "failed",
      });
      seedTask("next", "par", 200);

      expect(processAutoQueueAdvance()).toBe(0);
      expect(findTaskById("next")?.status).toBe("backlog");
    });

    it("backfills as one task reaches done", () => {
      seedTask("t1", "par", 100, { status: "planning" });
      seedTask("t2", "par", 200, { status: "implementing" });
      seedTask("t3", "par", 300, { status: "review" });
      seedTask("t4", "par", 400);

      expect(processAutoQueueAdvance()).toBe(0);
      updateTaskStatus("t1", "done");
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t4")?.status).toBe("planning");
    });

    it("paused backlog tasks do not count and are skipped", () => {
      seedTask("t1", "par", 100, { paused: true });
      seedTask("t2", "par", 200, { paused: true });
      seedTask("t3", "par", 300);

      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(1);
      expect(findTaskById("t3")?.status).toBe("planning");
      // paused ones stay
      expect(findTaskById("t1")?.status).toBe("backlog");
      expect(findTaskById("t2")?.status).toBe("backlog");
    });
  });

  describe("scheduler + auto-queue interaction", () => {
    it("scheduled task fires first; auto-queue then fills the rest of the pool", () => {
      seedProject("mix", { autoQueue: true, parallel: true });
      const past = new Date(Date.now() - 60_000).toISOString();
      seedTask("scheduled", "mix", 50, { scheduledAt: past });
      seedTask("a", "mix", 100);
      seedTask("b", "mix", 200);
      seedTask("c", "mix", 300);

      // Scheduler runs first
      const fired = processDueScheduledTasks();
      expect(fired).toBe(1);
      expect(findTaskById("scheduled")?.status).toBe("planning");
      expect(findTaskById("scheduled")?.scheduledAt).toBeNull();

      // Auto-queue then tops up to 3 in flight: scheduled + 2 more
      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(2);
      expect(findTaskById("a")?.status).toBe("planning");
      expect(findTaskById("b")?.status).toBe("planning");
      expect(findTaskById("c")?.status).toBe("backlog");
    });

    it("paused backlog with a due scheduledAt is NOT fired by scheduler", () => {
      seedProject("pq", { autoQueue: true });
      const past = new Date(Date.now() - 60_000).toISOString();
      seedTask("t1", "pq", 100, { scheduledAt: past });
      setTaskFields("t1", { paused: true, scheduledAt: past });

      expect(processDueScheduledTasks()).toBe(0);
      expect(findTaskById("t1")?.status).toBe("backlog");
    });

    it("does not fire an auto-queue scheduled task from a dirty Git worktree", () => {
      const root = createGitTestRoot("autoqueue-scheduled-dirty-", {
        readme: "# scheduled\n",
      }).rootPath;

      testDb.current
        .insert(projects)
        .values({
          id: "scheduled-dirty",
          name: "scheduled-dirty",
          rootPath: root,
          autoQueueMode: true,
        })
        .run();
      const past = new Date(Date.now() - 60_000).toISOString();
      seedTask("scheduled-dirty-task", "scheduled-dirty", 100, { scheduledAt: past });
      writeFileSync(join(root, "unrelated.txt"), "do not commit\n");

      expect(processDueScheduledTasks()).toBe(0);
      expect(findTaskById("scheduled-dirty-task")?.status).toBe("backlog");
      expect(findTaskById("scheduled-dirty-task")?.scheduledAt).toBe(past);
      expect(findTaskById("scheduled-dirty-task")?.autoQueueCommitStatus).toBeNull();
    });
  });

  describe("CAS race protection", () => {
    it("scheduler and auto-queue cannot double-advance the same task in one cycle", () => {
      seedProject("race", { autoQueue: true, parallel: false });
      const past = new Date(Date.now() - 60_000).toISOString();
      // Single task that is BOTH due and the next backlog item by position.
      seedTask("solo", "race", 100, { scheduledAt: past });

      const fired = processDueScheduledTasks();
      const advanced = processAutoQueueAdvance();

      // Scheduler claimed it; auto-queue saw it as already in flight.
      expect(fired).toBe(1);
      expect(advanced).toBe(0);
      expect(findTaskById("solo")?.status).toBe("planning");
      expect(findTaskById("solo")?.scheduledAt).toBeNull();
    });
  });

  describe("toggle path", () => {
    it("setAutoQueueMode controls whether the project is processed", () => {
      seedProject("toggle", { autoQueue: false });
      seedTask("t1", "toggle", 100);
      expect(processAutoQueueAdvance()).toBe(0);

      setAutoQueueMode("toggle", true);
      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t1")?.status).toBe("planning");
    });
  });

  describe("dirty-worktree gate", () => {
    it("pauses advance when the project work tree has uncommitted changes", () => {
      const root = createGitTestRoot("autoqueue-dirty-", {
        configYaml: "git:\n  create_branches: false\n",
      }).rootPath;

      // Project points at a REAL git repo; seedProject uses /tmp/<id>,
      // so insert directly with the real path.
      testDb.current
        .insert(projects)
        .values({
          id: "dirty",
          name: "dirty",
          rootPath: root,
          parallelEnabled: false,
          autoQueueMode: true,
        })
        .run();
      seedTask("t-dirty-1", "dirty", 100);

      // Introduce uncommitted change
      writeFileSync(join(root, "scratch.txt"), "dirty\n");

      const advanced = processAutoQueueAdvance();
      expect(advanced).toBe(0);
      expect(findTaskById("t-dirty-1")?.status).toBe("backlog");
    });

    it("advances normally once the work tree is clean again", () => {
      const root = createGitTestRoot("autoqueue-clean-").rootPath;

      testDb.current
        .insert(projects)
        .values({
          id: "clean",
          name: "clean",
          rootPath: root,
          parallelEnabled: false,
          autoQueueMode: true,
        })
        .run();
      seedTask("t-clean-1", "clean", 100);

      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t-clean-1")?.status).toBe("planning");
    });

    it("fills the parallel pool for worktree-capable branch-isolated git projects", () => {
      const root = createGitTestRoot("autoqueue-parallel-branch-").rootPath;

      testDb.current
        .insert(projects)
        .values({
          id: "parallel-branch",
          name: "parallel-branch",
          rootPath: root,
          parallelEnabled: true,
          autoQueueMode: true,
        })
        .run();
      seedTask("t-branch-1", "parallel-branch", 100);
      seedTask("t-branch-2", "parallel-branch", 200);
      seedTask("t-branch-3", "parallel-branch", 300);

      expect(processAutoQueueAdvance()).toBe(3);
      expect(findTaskById("t-branch-1")?.status).toBe("planning");
      expect(findTaskById("t-branch-2")?.status).toBe("planning");
      expect(findTaskById("t-branch-3")?.status).toBe("planning");
    });

    it("serializes a parallel auto-queue project when tasks share one Git working tree", () => {
      const root = createGitTestRoot("autoqueue-shared-git-", {
        configYaml: "git:\n  create_branches: false\n",
      }).rootPath;

      testDb.current
        .insert(projects)
        .values({
          id: "parallel-shared",
          name: "parallel-shared",
          rootPath: root,
          parallelEnabled: true,
          autoQueueMode: true,
        })
        .run();
      seedTask("t-shared-1", "parallel-shared", 100);
      seedTask("t-shared-2", "parallel-shared", 200);

      expect(processAutoQueueAdvance()).toBe(1);
      expect(findTaskById("t-shared-1")?.status).toBe("planning");
      expect(findTaskById("t-shared-2")?.status).toBe("backlog");
    });
  });
});
