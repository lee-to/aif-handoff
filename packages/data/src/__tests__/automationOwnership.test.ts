import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  blockTaskForRuntimeGateIfEligible,
  claimBacklogTaskForAdvance,
  claimCoordinatorTaskIfEligible,
  countActivePipelineTasksForProject,
  createTask,
  findCoordinatorTaskCandidates,
  findCoordinatorTaskCandidatesForProject,
  hasBlockingAutoQueueCommitForProject,
  listCoordinatorActionableProjectIds,
  listDueBlockedExternalTasks,
  listDueScheduledTasks,
  listStaleInProgressTasks,
  nextBacklogTaskByPosition,
  tryStartQaRun,
} = await import("../index.js");

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values([
      {
        id: "mixed-project",
        name: "Mixed",
        rootPath: "/tmp/mixed",
        autoQueueMode: true,
      },
      {
        id: "human-project",
        name: "Human",
        rootPath: "/tmp/human",
        autoQueueMode: true,
      },
    ])
    .run();
});

function createOwnedTask(
  projectId: string,
  title: string,
  executionOwner: "ai" | "human",
) {
  const task = createTask({
    projectId,
    title,
    description: "",
    executionOwner,
  });
  expect(task).toBeDefined();
  if (!task) throw new Error("task fixture was not created");
  return task;
}

describe("AI automation ownership boundary", () => {
  it("excludes human tasks from coordinator selection, claims, budgets, and watchdog scans", () => {
    const ai = createOwnedTask("mixed-project", "AI", "ai");
    const human = createOwnedTask("mixed-project", "Human", "human");
    const humanOnly = createOwnedTask("human-project", "Human only", "human");
    testDb.current
      .update(tasks)
      .set({ status: "planning" })
      .where(eq(tasks.id, ai.id))
      .run();
    testDb.current
      .update(tasks)
      .set({ status: "planning" })
      .where(eq(tasks.id, human.id))
      .run();
    testDb.current
      .update(tasks)
      .set({ status: "planning" })
      .where(eq(tasks.id, humanOnly.id))
      .run();

    expect(findCoordinatorTaskCandidates("planner", 10).map((task) => task.id)).toEqual([
      ai.id,
    ]);
    expect(
      findCoordinatorTaskCandidatesForProject("mixed-project", "planner", 10).map(
        (task) => task.id,
      ),
    ).toEqual([ai.id]);
    expect(listCoordinatorActionableProjectIds(10)).toEqual(["mixed-project"]);
    expect(countActivePipelineTasksForProject("mixed-project")).toBe(1);
    expect(listStaleInProgressTasks().map((task) => task.id)).toEqual([ai.id]);
    expect(
      claimCoordinatorTaskIfEligible({
        taskId: human.id,
        expectedProjectId: human.projectId,
        expectedStatus: "planning",
        coordinatorId: "coordinator",
        lockDurationMs: 60_000,
      }),
    ).toBeUndefined();
  });

  it("excludes human tasks from scheduler, auto-queue, runtime gate, commit capacity, and QA", () => {
    const human = createOwnedTask("mixed-project", "Human backlog", "human");
    const ai = createOwnedTask("mixed-project", "AI backlog", "ai");
    const past = "2026-01-01T00:00:00.000Z";
    testDb.current
      .update(tasks)
      .set({ scheduledAt: past })
      .where(eq(tasks.id, human.id))
      .run();
    testDb.current
      .update(tasks)
      .set({ scheduledAt: past })
      .where(eq(tasks.id, ai.id))
      .run();

    expect(listDueScheduledTasks("2026-01-02T00:00:00.000Z").map((task) => task.id)).toEqual([
      ai.id,
    ]);
    expect(nextBacklogTaskByPosition("mixed-project")?.id).toBe(ai.id);
    expect(claimBacklogTaskForAdvance(human.id)).toBe(false);
    expect(
      blockTaskForRuntimeGateIfEligible({
        taskId: human.id,
        expectedStatus: "backlog",
        blockedFromStatus: "backlog",
        blockedReason: "limit",
        retryAfter: null,
        retryCount: 1,
        snapshot: null,
      }),
    ).toBe(false);
    expect(tryStartQaRun(human.id)).toBe(false);

    testDb.current
      .update(tasks)
      .set({ status: "done", autoQueueCommitStatus: "failed" })
      .where(eq(tasks.id, human.id))
      .run();
    expect(hasBlockingAutoQueueCommitForProject("mixed-project")).toBe(false);
  });

  it("does not release blocked human work through the AI watchdog", () => {
    const human = createOwnedTask("human-project", "Human blocked", "human");
    const ai = createOwnedTask("mixed-project", "AI blocked", "ai");
    const due = "2026-01-01T00:00:00.000Z";
    for (const task of [human, ai]) {
      testDb.current
        .update(tasks)
        .set({
          status: "blocked_external",
          blockedFromStatus: "planning",
          retryAfter: due,
        })
        .where(eq(tasks.id, task.id))
        .run();
    }
    expect(
      listDueBlockedExternalTasks("2026-01-02T00:00:00.000Z").map((task) => task.id),
    ).toEqual([ai.id]);
  });
});
