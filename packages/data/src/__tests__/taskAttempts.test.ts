import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => Object.assign(actual.getEnv(), { AIF_AGENT_ATTEMPT_RECOVERY_ENABLED: true }),
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const {
  applyTaskAction,
  assertTaskAttemptCurrent,
  claimCoordinatorTaskIfEligible,
  createTaskComment,
  findTaskById,
  getTaskAttempt,
  handoffTaskExecution,
  isTaskAttemptCurrent,
  listTaskComments,
  persistTaskPlanForTask,
  releaseTaskClaim,
  renewTaskClaim,
  setTaskFields,
  SupersededTaskAttemptError,
  updateTaskHeartbeat,
  updateTaskStatus,
  withTaskAttempt,
} = await import("../index.js");

let root: string;
beforeEach(() => {
  testDb.current = createTestDb();
  root = mkdtempSync(join(tmpdir(), "aif-attempt-test-"));
  testDb.current.insert(projects).values({ id: "project", name: "Attempts", rootPath: root }).run();
  testDb.current
    .insert(tasks)
    .values({ id: "task", projectId: "project", title: "Attempt", status: "planning" })
    .run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function claim() {
  const row = claimCoordinatorTaskIfEligible({
    taskId: "task",
    expectedProjectId: "project",
    expectedStatus: "planning",
    coordinatorId: "coordinator",
    lockDurationMs: 60_000,
  })!;
  return {
    taskId: row.id,
    attemptId: row.stageAttemptId!,
    coordinatorId: row.lockedBy!,
    ownershipRevision: row.ownershipRevision,
  };
}

describe("coordinator attempt fencing", () => {
  it("keeps unscoped API writes available and captures the started-stage marker only on claim", () => {
    expect(findTaskById("task")!.stageStartedAt).toBeNull();
    expect(isTaskAttemptCurrent("task")).toBe(true);
    setTaskFields("task", { plan: "API plan" });
    expect(getTaskAttempt()).toBeUndefined();
    const attempt = claim();
    expect(findTaskById("task")!.stageStartedAt).not.toBeNull();
    withTaskAttempt(attempt, () => {
      assertTaskAttemptCurrent("task");
      expect(getTaskAttempt()).toEqual(attempt);
      expect(isTaskAttemptCurrent("other-task")).toBe(false);
      setTaskFields("task", { implementationLog: "current output" });
    });
    expect(findTaskById("task")!.implementationLog).toBe("current output");
    expect(getTaskAttempt()).toBeUndefined();
  });

  it("rotates identity even when the same coordinator acquires the same stage again", () => {
    const old = claim();
    releaseTaskClaim("task", "coordinator", old.attemptId);
    const current = claim();
    expect(current.attemptId).not.toBe(old.attemptId);
    withTaskAttempt(old, () => {
      expect(isTaskAttemptCurrent("task")).toBe(false);
      expect(() => setTaskFields("task", { plan: "obsolete" })).toThrow(SupersededTaskAttemptError);
      expect(() => updateTaskStatus("task", "plan_ready")).toThrow(SupersededTaskAttemptError);
      expect(() =>
        createTaskComment({ taskId: "task", author: "agent", message: "obsolete" }),
      ).toThrow(SupersededTaskAttemptError);
      expect(() => renewTaskClaim("task", "coordinator", 600_000)).toThrow(
        SupersededTaskAttemptError,
      );
      expect(() => updateTaskHeartbeat("task")).toThrow(SupersededTaskAttemptError);
    });
    expect(listTaskComments("task")).toHaveLength(0);
    releaseTaskClaim("task", "coordinator", old.attemptId);
    expect(findTaskById("task")!.lockedBy).toBe("coordinator");
    expect(findTaskById("task")!.stageAttemptId).toBe(current.attemptId);
  });

  it("prevents an old plan from changing the database or the canonical plan file", () => {
    const old = claim();
    releaseTaskClaim("task", "coordinator", old.attemptId);
    const current = claim();
    withTaskAttempt(current, () =>
      persistTaskPlanForTask({
        taskId: "task",
        planText: "new plan",
        projectRoot: root,
        isFix: false,
        planPath: "PLAN.md",
      }),
    );
    withTaskAttempt(old, () => {
      expect(() =>
        persistTaskPlanForTask({
          taskId: "task",
          planText: "old plan",
          projectRoot: root,
          isFix: false,
          planPath: "PLAN.md",
        }),
      ).toThrow(SupersededTaskAttemptError);
    });
    expect(findTaskById("task")!.plan).toBe("new plan");
    expect(readFileSync(join(root, "PLAN.md"), "utf8")).toContain("new plan");
  });

  it("rejects a completion after claim release, even before another attempt starts", () => {
    const old = claim();
    releaseTaskClaim("task", "coordinator", old.attemptId);
    withTaskAttempt(old, () =>
      expect(() => assertTaskAttemptCurrent("task")).toThrow(SupersededTaskAttemptError),
    );
  });

  it("rejects writes after an external human handoff changes ownership revision", () => {
    const old = claim();
    expect(
      handoffTaskExecution({
        taskId: "task",
        executionOwner: "human",
        expectedOwnershipRevision: 0,
        allowLockedBy: "coordinator",
        actor: { kind: "system", id: "operator", displayNameSnapshot: "Operator" },
      }).ok,
    ).toBe(true);
    withTaskAttempt(old, () =>
      expect(() => setTaskFields("task", { plan: "old" })).toThrow(SupersededTaskAttemptError),
    );
  });

  it("allows the current attempt to finish its own manual-review handoff", () => {
    const attempt = claim();
    withTaskAttempt(attempt, () => {
      expect(
        handoffTaskExecution({
          taskId: "task",
          executionOwner: "human",
          expectedOwnershipRevision: 0,
          allowLockedBy: "coordinator",
          actor: { kind: "system", id: "review-gate", displayNameSnapshot: "Review Gate" },
        }).ok,
      ).toBe(true);
      setTaskFields("task", { manualReviewRequired: true });
    });
    expect(findTaskById("task")).toMatchObject({
      executionOwner: "human",
      manualReviewRequired: true,
    });
    withTaskAttempt(attempt, () => expect(isTaskAttemptCurrent("task")).toBe(false));
  });

  it("clears the started marker on stage exit but retains it on failed same-stage retry", () => {
    claim();
    updateTaskStatus("task", "planning");
    expect(findTaskById("task")!.stageStartedAt).not.toBeNull();
    updateTaskStatus("task", "plan_ready");
    expect(findTaskById("task")!.stageStartedAt).toBeNull();
  });

  it("invalidates the old attempt when a human requests a new planning pass", () => {
    const old = claim();
    updateTaskStatus("task", "plan_ready");
    expect(
      applyTaskAction({
        taskId: "task",
        event: "request_replanning",
        participantsModeEnabled: false,
        actor: { kind: "system", id: "human-action", displayNameSnapshot: "Operator" },
      }).ok,
    ).toBe(true);
    expect(findTaskById("task")).toMatchObject({
      status: "planning",
      stageStartedAt: null,
      stageAttemptId: null,
      lockedBy: null,
      lockedUntil: null,
    });
    withTaskAttempt(old, () =>
      expect(() => setTaskFields("task", { plan: "obsolete" })).toThrow(SupersededTaskAttemptError),
    );
  });
});
