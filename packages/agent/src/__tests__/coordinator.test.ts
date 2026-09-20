import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  auditEvents,
  taskExecutorHistory,
  tasks,
  projects,
  runtimeProfiles,
  getEnv,
  resetEnvCache,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { RuntimeExecutionError } from "@aif/runtime";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitTestRoot } from "./gitTestUtils.js";

// Flag defaults to false (opt-in). Coordinator tests assert on persisted
// limitSnapshot, which requires the gate to be open.
process.env.AIF_USAGE_LIMITS_ENABLED = "true";
process.env.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED = "true";
resetEnvCache();

// Set up test db
const testDb = { current: createTestDb() };
const blockTaskForRuntimeGateIfEligibleMock = vi.fn();
const claimCoordinatorTaskIfEligibleMock = vi.fn();
const executeSubagentQueryMock = vi.fn();

function createGitRoot(prefix: string): string {
  return createGitTestRoot(prefix, { readme: "# auto queue\n" }).rootPath;
}

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  blockTaskForRuntimeGateIfEligibleMock.mockImplementation(
    actual.blockTaskForRuntimeGateIfEligible,
  );
  claimCoordinatorTaskIfEligibleMock.mockImplementation(actual.claimCoordinatorTaskIfEligible);
  return {
    ...actual,
    blockTaskForRuntimeGateIfEligible: (
      ...args: Parameters<typeof actual.blockTaskForRuntimeGateIfEligible>
    ) => blockTaskForRuntimeGateIfEligibleMock(...args),
    claimCoordinatorTaskIfEligible: (
      ...args: Parameters<typeof actual.claimCoordinatorTaskIfEligible>
    ) => claimCoordinatorTaskIfEligibleMock(...args),
  };
});

vi.mock("../subagentQuery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../subagentQuery.js")>();
  return {
    ...actual,
    executeSubagentQuery: (...args: unknown[]) => executeSubagentQueryMock(...args),
  };
});

// Mock subagent runners
vi.mock("../subagents/planner.js", () => ({
  runPlanner: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../subagents/improver.js", () => ({
  runImprover: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../subagents/planChecker.js", () => ({
  runPlanChecker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../subagents/implementer.js", () => ({
  runImplementer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../subagents/reviewer.js", () => ({
  runReviewer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../subagents/verifier.js", () => ({
  runVerifier: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../reviewGate.js", () => ({
  evaluateReviewCommentsForAutoMode: vi.fn().mockResolvedValue({ status: "success" }),
}));
vi.mock("../autoReviewHandler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../autoReviewHandler.js")>();
  return {
    ...actual,
    handleAutoReviewGate: vi.fn().mockResolvedValue({
      status: "accepted",
      currentIteration: 1,
      metrics: {
        strategy: "full_re_review",
        iteration: 1,
        previousBlockingCount: 0,
        stillBlockingCount: 0,
        newBlockingCount: 0,
        totalBlockingCount: 0,
        parserMode: "structured",
      },
      autoReviewState: null,
    }),
  };
});

const {
  pollAndProcess,
  getCoordinatorRuntimeCounters,
  resetCoordinatorRuntimeCountersForTests,
  getStageSemaphore,
} = await import("../coordinator.js");
const { runPlanner } = await import("../subagents/planner.js");
const { runImprover } = await import("../subagents/improver.js");
const { runPlanChecker } = await import("../subagents/planChecker.js");
const { runImplementer } = await import("../subagents/implementer.js");
const { runReviewer } = await import("../subagents/reviewer.js");
const { runVerifier } = await import("../subagents/verifier.js");
const { handleAutoReviewGate } = await import("../autoReviewHandler.js");
const { StageManualBlockError } = await import("../stageErrorHandler.js");

describe("coordinator", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    testDb.current
      .insert(projects)
      .values({ id: "test-project", name: "Test", rootPath: "/tmp/test" })
      .run();
    vi.clearAllMocks();
    executeSubagentQueryMock.mockResolvedValue({ resultText: "done" });
    resetCoordinatorRuntimeCountersForTests();
    getStageSemaphore().reset();
  });

  it("should remove inactive project-stage semaphore keys", async () => {
    const semaphore = getStageSemaphore();

    await semaphore.acquire("project-1:planner", 2, 2);
    await semaphore.acquire("project-1:planner", 2, 2);
    expect(semaphore.totalActive()).toBe(2);
    expect(semaphore.trackedKeyCount()).toBe(1);

    semaphore.release("project-1:planner");
    expect(semaphore.totalActive()).toBe(1);
    expect(semaphore.trackedKeyCount()).toBe(1);

    semaphore.release("project-1:planner");
    semaphore.release("missing:planner");
    expect(semaphore.totalActive()).toBe(0);
    expect(semaphore.trackedKeyCount()).toBe(0);
  });

  function insertRuntimeProfile(input: {
    id: string;
    projectId?: string | null;
    snapshot: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    testDb.current
      .insert(runtimeProfiles)
      .values({
        id: input.id,
        projectId: input.projectId ?? "test-project",
        name: `Profile ${input.id}`,
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
        runtimeLimitSnapshotJson: JSON.stringify(input.snapshot),
        runtimeLimitUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("should pick up planning tasks and process through full pipeline", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({ id: "task-1", projectId: "test-project", title: "Plan me", status: "planning" })
      .run();

    await pollAndProcess();

    // Pipeline processes all three stages in one poll cycle
    expect(runPlanner).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runImprover).not.toHaveBeenCalled();
    expect(runPlanChecker).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runImplementer).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runVerifier).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(task!.status).toBe("done");
  });

  it("commits a completed auto-queue task before the next task can start", async () => {
    const db = testDb.current;
    const rootPath = createGitRoot("coordinator-auto-commit-");

    db.insert(projects)
      .values({
        id: "auto-commit-project",
        name: "Auto Commit",
        rootPath,
        autoQueueMode: true,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "auto-commit-task-a",
        projectId: "auto-commit-project",
        title: "Task A",
        status: "backlog",
        position: 100,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "auto-commit-task-b",
        projectId: "auto-commit-project",
        title: "Task B",
        status: "backlog",
        position: 200,
      })
      .run();

    vi.mocked(runImplementer).mockImplementationOnce(async () => {
      writeFileSync(join(rootPath, "task-a.txt"), "task A\n");
    });
    executeSubagentQueryMock.mockImplementationOnce(async (input: { projectRoot: string }) => {
      execFileSync("git", ["add", "-A"], { cwd: input.projectRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feat: complete task A"], {
        cwd: input.projectRoot,
        stdio: "ignore",
      });
      return { resultText: "commit created" };
    });

    await pollAndProcess();

    const taskA = db.select().from(tasks).where(eq(tasks.id, "auto-commit-task-a")).get();
    const taskB = db.select().from(tasks).where(eq(tasks.id, "auto-commit-task-b")).get();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: rootPath,
      encoding: "utf8",
    });

    expect(taskA?.status).toBe("done");
    expect(taskA?.autoQueueCommitStatus).toBe("committed");
    expect(taskA?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(taskB?.status).toBe("backlog");
    expect(executeSubagentQueryMock).toHaveBeenCalledTimes(1);
    expect(status).toBe("");

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("auto-commit-task-b", rootPath);
  });

  it("blocks the next auto-queue task when the completion commit is not created", async () => {
    const db = testDb.current;
    const rootPath = createGitRoot("coordinator-auto-commit-failure-");
    db.insert(projects)
      .values({
        id: "auto-commit-failure-project",
        name: "Auto Commit Failure",
        rootPath,
        autoQueueMode: true,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "auto-commit-failure-a",
        projectId: "auto-commit-failure-project",
        title: "Task A",
        status: "backlog",
        position: 100,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "auto-commit-failure-b",
        projectId: "auto-commit-failure-project",
        title: "Task B",
        status: "backlog",
        position: 200,
      })
      .run();
    vi.mocked(runImplementer).mockImplementationOnce(async () => {
      writeFileSync(join(rootPath, "task-a.txt"), "task A\n");
    });
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "did not commit" });

    await pollAndProcess();
    await pollAndProcess();

    const taskA = db.select().from(tasks).where(eq(tasks.id, "auto-commit-failure-a")).get();
    const taskB = db.select().from(tasks).where(eq(tasks.id, "auto-commit-failure-b")).get();

    expect(taskA?.status).toBe("blocked_external");
    expect(taskA?.blockedFromStatus).toBe("review");
    expect(taskA?.autoQueueCommitStatus).toBe("failed");
    expect(taskA?.commitSha).toBeNull();
    expect(taskB?.status).toBe("backlog");
    expect(runPlanner).not.toHaveBeenCalledWith("auto-commit-failure-b", rootPath);
  });

  it("should run optional improve stage only for skills-mode tasks", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-improve",
        projectId: "test-project",
        title: "Improve my plan",
        status: "planning",
        useSubagents: false,
        runPlanImprove: true,
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("task-improve", "/tmp/test");
    expect(runImprover).toHaveBeenCalledWith("task-improve", "/tmp/test");
    expect(runPlanChecker).toHaveBeenCalledWith("task-improve", "/tmp/test");
    const task = db.select().from(tasks).where(eq(tasks.id, "task-improve")).get();
    expect(task!.status).toBe("done");
  });

  it("should not run optional improve stage for subagent tasks even if flag is set", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-subagent-improve",
        projectId: "test-project",
        title: "Subagent plan",
        status: "planning",
        useSubagents: true,
        runPlanImprove: true,
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("task-subagent-improve", "/tmp/test");
    expect(runImprover).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-subagent-improve")).get();
    expect(task!.status).toBe("done");
  });

  it("should use task worktreePath as cwd for all downstream stages", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-worktree",
        projectId: "test-project",
        title: "Worktree task",
        status: "planning",
        branchName: "feature/worktree-task",
        worktreePath: "/tmp/test-worktree",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("task-worktree", "/tmp/test-worktree");
    expect(runPlanChecker).toHaveBeenCalledWith("task-worktree", "/tmp/test-worktree");
    expect(runImplementer).toHaveBeenCalledWith("task-worktree", "/tmp/test-worktree");
    expect(runReviewer).toHaveBeenCalledWith("task-worktree", "/tmp/test-worktree");
    expect(handleAutoReviewGate).toHaveBeenCalledWith({
      taskId: "task-worktree",
      projectRoot: "/tmp/test-worktree",
    });
  });

  it("should ignore backlog tasks until human starts AI", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-planning",
        projectId: "test-project",
        title: "Backlog task",
        status: "backlog",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-planning")).get();
    expect(task!.status).toBe("backlog");
  });

  it("should ignore verified tasks", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-verified",
        projectId: "test-project",
        title: "Verified task",
        status: "verified",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-verified")).get();
    expect(task!.status).toBe("verified");
  });

  it("should pick up plan_ready tasks and dispatch implementer + reviewer", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-2",
        projectId: "test-project",
        title: "Implement me",
        status: "plan_ready",
        autoMode: true,
      })
      .run();

    await pollAndProcess();

    expect(runPlanChecker).toHaveBeenCalledWith("task-2", "/tmp/test");
    expect(runImplementer).toHaveBeenCalledWith("task-2", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-2", "/tmp/test");
    expect(runVerifier).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(task!.status).toBe("done");
  });

  it("should run optional verify stage only for skills-mode tasks", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-verify",
        projectId: "test-project",
        title: "Verify me",
        status: "plan_ready",
        autoMode: true,
        useSubagents: false,
        runPostVerify: true,
      })
      .run();

    await pollAndProcess();

    expect(runImplementer).toHaveBeenCalledWith("task-verify", "/tmp/test");
    expect(runVerifier).toHaveBeenCalledWith("task-verify", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-verify", "/tmp/test");
    expect(vi.mocked(runImplementer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runVerifier).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(runVerifier).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runReviewer).mock.invocationCallOrder[0] ?? 0,
    );
    const task = db.select().from(tasks).where(eq(tasks.id, "task-verify")).get();
    expect(task!.status).toBe("done");
  });

  it("should block verify tasks instead of retrying when verify gate blocks", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-blocking-verify",
        projectId: "test-project",
        title: "Blocking verify",
        status: "verify",
        useSubagents: false,
        runPostVerify: true,
      })
      .run();

    vi.mocked(runVerifier).mockRejectedValueOnce(
      new StageManualBlockError(
        "Verify stage returned a blocking gate result. Review the Verification section for details.",
      ),
    );

    await pollAndProcess();

    expect(runVerifier).toHaveBeenCalledTimes(1);
    expect(runReviewer).not.toHaveBeenCalled();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-blocking-verify")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("verify");
    expect(task!.blockedReason).toBe(
      "Verify stage returned a blocking gate result. Review the Verification section for details.",
    );
    expect(task!.retryAfter).toBeNull();

    await pollAndProcess();

    expect(runVerifier).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "subagent mode ignores improve/verify and runs review",
      useSubagents: true,
      skipReview: false,
      runPlanImprove: true,
      runPostVerify: true,
      expectImprover: false,
      expectVerifier: false,
      expectReviewer: true,
    },
    {
      name: "subagent mode with skipReview ignores verify and goes done",
      useSubagents: true,
      skipReview: true,
      runPlanImprove: true,
      runPostVerify: true,
      expectImprover: false,
      expectVerifier: false,
      expectReviewer: false,
    },
    {
      name: "skills mode baseline runs review",
      useSubagents: false,
      skipReview: false,
      runPlanImprove: false,
      runPostVerify: false,
      expectImprover: false,
      expectVerifier: false,
      expectReviewer: true,
    },
    {
      name: "skills mode skipReview goes done",
      useSubagents: false,
      skipReview: true,
      runPlanImprove: false,
      runPostVerify: false,
      expectImprover: false,
      expectVerifier: false,
      expectReviewer: false,
    },
    {
      name: "skills mode improve then review",
      useSubagents: false,
      skipReview: false,
      runPlanImprove: true,
      runPostVerify: false,
      expectImprover: true,
      expectVerifier: false,
      expectReviewer: true,
    },
    {
      name: "skills mode improve with skipReview goes done",
      useSubagents: false,
      skipReview: true,
      runPlanImprove: true,
      runPostVerify: false,
      expectImprover: true,
      expectVerifier: false,
      expectReviewer: false,
    },
    {
      name: "skills mode verify then review",
      useSubagents: false,
      skipReview: false,
      runPlanImprove: false,
      runPostVerify: true,
      expectImprover: false,
      expectVerifier: true,
      expectReviewer: true,
    },
    {
      name: "skills mode verify with skipReview goes done",
      useSubagents: false,
      skipReview: true,
      runPlanImprove: false,
      runPostVerify: true,
      expectImprover: false,
      expectVerifier: true,
      expectReviewer: false,
    },
    {
      name: "skills mode improve and verify then review",
      useSubagents: false,
      skipReview: false,
      runPlanImprove: true,
      runPostVerify: true,
      expectImprover: true,
      expectVerifier: true,
      expectReviewer: true,
    },
    {
      name: "skills mode improve and verify with skipReview goes done",
      useSubagents: false,
      skipReview: true,
      runPlanImprove: true,
      runPostVerify: true,
      expectImprover: true,
      expectVerifier: true,
      expectReviewer: false,
    },
  ])(
    "should follow the skills-mode flag truth table: $name",
    async ({
      name,
      useSubagents,
      skipReview,
      runPlanImprove,
      runPostVerify,
      expectImprover,
      expectVerifier,
      expectReviewer,
    }) => {
      const db = testDb.current;
      const taskId = `task-flag-table-${name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
      db.insert(tasks)
        .values({
          id: taskId,
          projectId: "test-project",
          title: name,
          status: "planning",
          autoMode: true,
          useSubagents,
          skipReview,
          runPlanImprove,
          runPostVerify,
        })
        .run();

      await pollAndProcess();

      expect(runPlanner).toHaveBeenCalledWith(taskId, "/tmp/test");
      expect(runPlanChecker).toHaveBeenCalledWith(taskId, "/tmp/test");
      expect(runImplementer).toHaveBeenCalledWith(taskId, "/tmp/test");

      if (expectImprover) {
        expect(runImprover).toHaveBeenCalledWith(taskId, "/tmp/test");
        expect(vi.mocked(runPlanner).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(runImprover).mock.invocationCallOrder[0] ?? 0,
        );
        expect(vi.mocked(runImprover).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(runPlanChecker).mock.invocationCallOrder[0] ?? 0,
        );
      } else {
        expect(runImprover).not.toHaveBeenCalled();
      }

      if (expectVerifier) {
        expect(runVerifier).toHaveBeenCalledWith(taskId, "/tmp/test");
        expect(vi.mocked(runImplementer).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(runVerifier).mock.invocationCallOrder[0] ?? 0,
        );
      } else {
        expect(runVerifier).not.toHaveBeenCalled();
      }

      if (expectReviewer) {
        expect(runReviewer).toHaveBeenCalledWith(taskId, "/tmp/test");
        const previousStageOrder = expectVerifier
          ? (vi.mocked(runVerifier).mock.invocationCallOrder[0] ?? 0)
          : (vi.mocked(runImplementer).mock.invocationCallOrder[0] ?? 0);
        expect(previousStageOrder).toBeLessThan(
          vi.mocked(runReviewer).mock.invocationCallOrder[0] ?? 0,
        );
      } else {
        expect(runReviewer).not.toHaveBeenCalled();
      }

      const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      expect(task!.status).toBe("done");
    },
  );

  it("should not auto-implement plan_ready tasks when autoMode=false", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-2-manual",
        projectId: "test-project",
        title: "Manual confirmation",
        status: "plan_ready",
        autoMode: false,
      })
      .run();

    await pollAndProcess();

    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-2-manual")).get();
    expect(task!.status).toBe("plan_ready");
  });

  it("should pick up implementing tasks and continue to review", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-impl",
        projectId: "test-project",
        title: "Resume impl",
        status: "implementing",
        activeRuntimeStatus: "implementing",
        activeRuntimeSelectionJson: JSON.stringify({ status: "implementing" }),
      })
      .run();
    vi.mocked(runImplementer).mockImplementationOnce(async () => {
      const task = db.select().from(tasks).where(eq(tasks.id, "task-impl")).get();
      expect(task!.activeRuntimeStatus).toBe("implementing");
      expect(task!.activeRuntimeSelectionJson).toBe(JSON.stringify({ status: "implementing" }));
    });

    await pollAndProcess();

    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).toHaveBeenCalledWith("task-impl", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-impl", "/tmp/test");
    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl")).get();
    expect(task!.status).toBe("done");
    expect(task!.activeRuntimeStatus).toBeNull();
    expect(task!.activeRuntimeSelectionJson).toBeNull();
  });

  it("should pick up review tasks and dispatch reviewer", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({ id: "task-3", projectId: "test-project", title: "Review me", status: "review" })
      .run();

    await pollAndProcess();

    expect(runReviewer).toHaveBeenCalledWith("task-3", "/tmp/test");
    expect(runPlanChecker).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-3")).get();
    expect(task!.status).toBe("done");
  });

  it("should auto-request changes after review when autoMode=true and fixes are found", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-review-fixes",
        projectId: "test-project",
        title: "Review with fixes",
        status: "review",
        autoMode: true,
        reviewComments: "## Code Review\n- fix issue A\n- fix issue B",
      })
      .run();

    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "rework_requested",
      currentIteration: 1,
      metrics: {
        strategy: "full_re_review",
        iteration: 1,
        previousBlockingCount: 0,
        stillBlockingCount: 0,
        newBlockingCount: 2,
        totalBlockingCount: 2,
        parserMode: "structured",
      },
      autoReviewState: {
        strategy: "full_re_review",
        iteration: 1,
        findings: [
          { id: "fix-a", source: "code_review", text: "fix issue A" },
          { id: "fix-b", source: "code_review", text: "fix issue B" },
        ],
      },
    });

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-review-fixes")).get();

    expect(task!.status).toBe("implementing");
    expect(task!.reworkRequested).toBe(true);
  });

  it("should skip auto review gate when autoMode=false", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-review-manual",
        projectId: "test-project",
        title: "Manual review mode",
        status: "review",
        autoMode: false,
        reviewComments: "Some review comments",
      })
      .run();

    // handleAutoReviewGate returns null for non-autoMode tasks
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce(null);

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-review-manual")).get();
    expect(task!.status).toBe("done");
  });

  it("should proceed to done when auto review gate accepts", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-review-auto-log",
        projectId: "test-project",
        title: "Auto review logging",
        status: "review",
        autoMode: true,
        reviewComments: "## Code Review\nLooks good",
      })
      .run();

    // handleAutoReviewGate returns "accepted" (default mock)
    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-review-auto-log")).get();
    expect(task!.status).toBe("done");
    expect(handleAutoReviewGate).toHaveBeenCalledWith({
      taskId: "task-review-auto-log",
      projectRoot: "/tmp/test",
    });
  });

  it("should auto-recover stale implementing task to blocked_external", async () => {
    const db = testDb.current;
    const staleDate = new Date(Date.now() - 100 * 60_000).toISOString();
    db.insert(tasks)
      .values({
        id: "task-stale-impl",
        projectId: "test-project",
        title: "Stale implementer",
        status: "implementing",
        updatedAt: staleDate,
      })
      .run();

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-stale-impl")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("implementing");
    expect(task!.blockedReason).toContain("Watchdog: task stale in implementing");
    expect(task!.retryAfter).toBeTruthy();
    expect(task!.retryCount).toBe(1);
    expect(runImplementer).not.toHaveBeenCalled();
  });

  it("should not treat task as stale when updatedAt is fresh but heartbeat is old", async () => {
    const db = testDb.current;
    const staleHeartbeat = new Date(Date.now() - 31 * 60_000).toISOString();
    const freshUpdatedAt = new Date().toISOString();
    db.insert(tasks)
      .values({
        id: "task-fresh-update",
        projectId: "test-project",
        title: "Freshly moved to implementing",
        status: "implementing",
        lastHeartbeatAt: staleHeartbeat,
        updatedAt: freshUpdatedAt,
      })
      .run();

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-fresh-update")).get();
    expect(task!.status).toBe("done");
    expect(task!.blockedReason).toBeNull();
    expect(runImplementer).toHaveBeenCalledWith("task-fresh-update", "/tmp/test");
  });

  it("should quarantine stale task when watchdog retry limit reached", async () => {
    const db = testDb.current;
    const staleDate = new Date(Date.now() - 100 * 60_000).toISOString();
    db.insert(tasks)
      .values({
        id: "task-stale-limit",
        projectId: "test-project",
        title: "Stale over limit",
        status: "implementing",
        retryCount: 3,
        updatedAt: staleDate,
      })
      .run();

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-stale-limit")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("implementing");
    expect(task!.blockedReason).toContain("auto-retry limit reached");
    expect(task!.retryAfter).toBeNull();
    expect(task!.retryCount).toBe(3);
    expect(runImplementer).not.toHaveBeenCalled();
  });

  it("should revert status on planner failure", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({ id: "task-4", projectId: "test-project", title: "Fail plan", status: "planning" })
      .run();

    vi.mocked(runPlanner).mockRejectedValueOnce(new Error("Planner crashed"));

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-4")).get();
    expect(task!.status).toBe("planning");
  });

  it("should move task to blocked_external on external planner failure", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-ext-1",
        projectId: "test-project",
        title: "External fail",
        status: "planning",
      })
      .run();

    vi.mocked(runPlanner).mockRejectedValueOnce(
      new RuntimeExecutionError("Claude Code process exited with code 1", undefined, "timeout"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-1")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("planning");
    expect(task!.blockedReason).toBe("Runtime request timed out. Task will retry automatically.");
    expect(task!.retryAfter).toBeTruthy();
    expect(task!.retryCount).toBe(1);
  });

  it("should redact raw upstream runtime bodies before persisting blocked task state", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-ext-redacted",
        projectId: "test-project",
        title: "External redaction",
        status: "planning",
      })
      .run();

    vi.mocked(runPlanner).mockRejectedValueOnce(
      new RuntimeExecutionError(
        'upstream leaked "token=abc123" <script>alert(1)</script>',
        undefined,
        "transport",
      ),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-redacted")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedReason).toBe("Runtime request failed. Task will retry automatically.");
    expect(task!.blockedReason).not.toContain("abc123");
    expect(task!.blockedReason).not.toContain("<script>");
    expect(task!.agentActivityLog).toContain(
      "Runtime request failed. Task will retry automatically.",
    );
    expect(task!.agentActivityLog).not.toContain("abc123");
    expect(task!.agentActivityLog).not.toContain("<script>");
  });

  it("should use structured resetAt and persist task limit snapshot on quota exhaustion", async () => {
    const db = testDb.current;
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    db.insert(tasks)
      .values({
        id: "task-ext-limit",
        projectId: "test-project",
        title: "External rate limit",
        status: "planning",
      })
      .run();

    vi.mocked(runPlanner).mockRejectedValueOnce(
      new RuntimeExecutionError("Usage limit exceeded", undefined, "rate_limit", {
        resetAt,
        limitSnapshot: {
          source: "sdk_event",
          status: "blocked",
          precision: "heuristic",
          checkedAt: "2026-04-17T00:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-1",
          primaryScope: "time",
          resetAt,
          retryAfterSeconds: null,
          warningThreshold: null,
          windows: [{ scope: "time", resetAt }],
          providerMeta: null,
        },
      }),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-limit")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("planning");
    expect(task!.retryAfter).toBe(resetAt);
    expect(task!.runtimeLimitSnapshotJson).toContain('"status":"blocked"');
    expect(task!.runtimeLimitSnapshotJson).toContain('"profileId":"profile-1"');
  });

  it("should proactively block planning work when the effective runtime profile is provider-blocked", async () => {
    const db = testDb.current;
    const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
    insertRuntimeProfile({
      id: "profile-plan-blocked",
      snapshot: {
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "profile-plan-blocked",
        primaryScope: "time",
        resetAt,
        retryAfterSeconds: null,
        warningThreshold: null,
        windows: [{ scope: "time", resetAt }],
        providerMeta: null,
      },
    });
    db.update(projects)
      .set({ defaultPlanRuntimeProfileId: "profile-plan-blocked" })
      .where(eq(projects.id, "test-project"))
      .run();
    db.insert(tasks)
      .values({
        id: "task-preblocked",
        projectId: "test-project",
        title: "Preblocked plan",
        status: "planning",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-preblocked")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("planning");
    expect(task!.blockedReason).toContain("time limit still blocked");
    expect(task!.blockedReason).toContain("hint=snapshot_reset_at");
    expect(task!.retryAfter).toBe(resetAt);
    expect(task!.runtimeLimitSnapshotJson).toContain('"profileId":"profile-plan-blocked"');
  });

  it("should proactively block exact-threshold planning work before the provider hard-fails", async () => {
    const db = testDb.current;
    const resetAt = new Date(Date.now() + 45 * 60_000).toISOString();
    insertRuntimeProfile({
      id: "profile-plan-threshold",
      snapshot: {
        source: "api_headers",
        status: "warning",
        precision: "exact",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "profile-plan-threshold",
        primaryScope: "requests",
        resetAt,
        retryAfterSeconds: null,
        warningThreshold: 10,
        windows: [
          {
            scope: "requests",
            percentRemaining: 5,
            warningThreshold: 10,
            resetAt,
          },
        ],
        providerMeta: null,
      },
    });
    db.update(projects)
      .set({ defaultPlanRuntimeProfileId: "profile-plan-threshold" })
      .where(eq(projects.id, "test-project"))
      .run();
    db.insert(tasks)
      .values({
        id: "task-threshold",
        projectId: "test-project",
        title: "Threshold gate",
        status: "planning",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-threshold")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("planning");
    expect(task!.blockedReason).toContain("requests threshold reached");
    expect(task!.blockedReason).toContain("5% <= 10%");
    expect(task!.blockedReason).toContain("hint=window_reset_at");
    expect(task!.retryAfter).toBe(resetAt);
    expect(task!.runtimeLimitSnapshotJson).toContain('"precision":"exact"');
  });

  it("should skip proactive runtime block side-effects when CAS update fails after candidate changes", async () => {
    const db = testDb.current;
    const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
    insertRuntimeProfile({
      id: "profile-plan-race",
      snapshot: {
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "profile-plan-race",
        primaryScope: "time",
        resetAt,
        retryAfterSeconds: null,
        warningThreshold: null,
        windows: [{ scope: "time", resetAt }],
        providerMeta: null,
      },
    });
    db.update(projects)
      .set({ defaultPlanRuntimeProfileId: "profile-plan-race" })
      .where(eq(projects.id, "test-project"))
      .run();
    db.insert(tasks)
      .values({
        id: "task-gate-race",
        projectId: "test-project",
        title: "Gate race",
        status: "planning",
      })
      .run();

    blockTaskForRuntimeGateIfEligibleMock.mockImplementationOnce(() => {
      db.update(tasks)
        .set({
          paused: true,
          lockedBy: "other-coordinator",
          lockedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, "task-gate-race"))
        .run();
      return false;
    });

    await pollAndProcess();

    expect(blockTaskForRuntimeGateIfEligibleMock).toHaveBeenCalledTimes(1);
    expect(runPlanner).not.toHaveBeenCalledWith("task-gate-race", "/tmp/test");

    const task = db.select().from(tasks).where(eq(tasks.id, "task-gate-race")).get();
    expect(task!.status).toBe("planning");
    expect(task!.paused).toBe(true);
    expect(task!.blockedReason).toBeNull();
    expect(task!.blockedFromStatus).toBeNull();
    expect(task!.retryAfter).toBeNull();
    expect(task!.runtimeLimitSnapshotJson).toBeNull();
    expect(task!.agentActivityLog).toBeNull();
  });

  it("should continue to later runnable candidates when the first planning task is gated by runtime limits", async () => {
    const db = testDb.current;
    const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
    insertRuntimeProfile({
      id: "profile-gated-first",
      snapshot: {
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "profile-gated-first",
        primaryScope: "time",
        resetAt,
        retryAfterSeconds: null,
        warningThreshold: null,
        windows: [{ scope: "time", resetAt }],
        providerMeta: null,
      },
    });
    db.update(projects)
      .set({ defaultPlanRuntimeProfileId: "profile-gated-first" })
      .where(eq(projects.id, "test-project"))
      .run();
    db.insert(projects)
      .values({ id: "project-runnable", name: "Runnable", rootPath: "/tmp/runnable" })
      .run();
    db.insert(tasks)
      .values({
        id: "task-gated-first",
        projectId: "test-project",
        title: "Blocked first",
        status: "planning",
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-runnable-second",
        projectId: "project-runnable",
        title: "Runnable second",
        status: "planning",
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalledWith("task-gated-first", "/tmp/test");
    expect(runPlanner).toHaveBeenCalledWith("task-runnable-second", "/tmp/runnable");

    const gatedTask = db.select().from(tasks).where(eq(tasks.id, "task-gated-first")).get();
    const runnableTask = db.select().from(tasks).where(eq(tasks.id, "task-runnable-second")).get();

    expect(gatedTask!.status).toBe("blocked_external");
    expect(gatedTask!.retryAfter).toBe(resetAt);
    expect(runnableTask!.status).toBe("done");
  });

  it("should not process blocked task before retryAfter", async () => {
    const db = testDb.current;
    const futureRetry = new Date(Date.now() + 10 * 60_000).toISOString();
    db.insert(tasks)
      .values({
        id: "task-ext-2",
        projectId: "test-project",
        title: "Blocked waiting",
        status: "blocked_external",
        blockedFromStatus: "planning",
        retryAfter: futureRetry,
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    expect(runPlanChecker).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-2")).get();
    expect(task!.status).toBe("blocked_external");
  });

  it("should release blocked task after retryAfter and continue pipeline", async () => {
    const db = testDb.current;
    const pastRetry = new Date(Date.now() - 60_000).toISOString();
    db.insert(tasks)
      .values({
        id: "task-ext-3",
        projectId: "test-project",
        title: "Blocked expired",
        status: "blocked_external",
        blockedFromStatus: "planning",
        retryAfter: pastRetry,
        retryCount: 2,
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("task-ext-3", "/tmp/test");
    expect(runPlanChecker).toHaveBeenCalledWith("task-ext-3", "/tmp/test");
    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-3")).get();
    expect(task!.status).toBe("done");
    expect(task!.blockedReason).toBeNull();
    expect(task!.blockedFromStatus).toBeNull();
    expect(task!.retryAfter).toBeNull();
    expect(task!.retryCount).toBe(0);
  });

  it("should revert status on implementer failure", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({ id: "task-5", projectId: "test-project", title: "Fail impl", status: "plan_ready" })
      .run();

    vi.mocked(runImplementer).mockRejectedValueOnce(new Error("Implementer crashed"));

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-5")).get();
    expect(task!.status).toBe("implementing");
  });

  it("should move task to blocked_external when implementer is blocked by permissions", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-impl-perm",
        projectId: "test-project",
        title: "Impl blocked",
        status: "plan_ready",
      })
      .run();

    vi.mocked(runImplementer).mockRejectedValueOnce(
      new RuntimeExecutionError("Implementer blocked by permissions", undefined, "permission"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl-perm")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("implementing");
    expect(task!.retryAfter).toBeTruthy();
  });

  it("should fast-retry on implementer stream interruption before worker dispatch", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-impl-stream",
        projectId: "test-project",
        title: "Impl stream issue",
        status: "plan_ready",
      })
      .run();

    vi.mocked(runImplementer).mockRejectedValueOnce(
      new Error("Claude stream interrupted before implement-worker dispatch"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl-stream")).get();
    expect(task!.status).toBe("implementing");
    expect(task!.blockedFromStatus).toBeNull();
    expect(task!.retryAfter).toBeNull();
    expect(task!.blockedReason).toBeNull();
    expect(getCoordinatorRuntimeCounters().fastRetryStreamInterruptions).toBe(1);
  });

  it("should revert to source status on checklist sync error from implementer", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-impl-checklist",
        projectId: "test-project",
        title: "Checklist guard",
        status: "plan_ready",
      })
      .run();

    vi.mocked(runImplementer).mockRejectedValueOnce(
      new Error("Plan checklist incomplete after implementation sync"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl-checklist")).get();
    expect(task!.status).toBe("implementing");
    expect(task!.blockedReason).toBeNull();
    expect(task!.retryAfter).toBeNull();
  });

  it("should revert status on plan checker failure", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-checker-fail",
        projectId: "test-project",
        title: "Fail checker",
        status: "plan_ready",
        autoMode: true,
      })
      .run();

    vi.mocked(runPlanChecker).mockRejectedValueOnce(new Error("Plan checker crashed"));

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-checker-fail")).get();
    expect(task!.status).toBe("plan_ready");
    expect(runImplementer).not.toHaveBeenCalled();
  });

  it("should skip review stage when skipReview=true and go directly to done", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skip-review",
        projectId: "test-project",
        title: "Skip review task",
        status: "implementing",
        skipReview: true,
      })
      .run();

    await pollAndProcess();

    expect(runImplementer).toHaveBeenCalledWith("task-skip-review", "/tmp/test");
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-skip-review")).get();
    expect(task!.status).toBe("done");
  });

  it("should verify before done when skipReview=true and runPostVerify=true", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skip-review-verify",
        projectId: "test-project",
        title: "Skip review verified task",
        status: "implementing",
        skipReview: true,
        useSubagents: false,
        runPostVerify: true,
      })
      .run();

    await pollAndProcess();

    expect(runImplementer).toHaveBeenCalledWith("task-skip-review-verify", "/tmp/test");
    expect(runVerifier).toHaveBeenCalledWith("task-skip-review-verify", "/tmp/test");
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-skip-review-verify")).get();
    expect(task!.status).toBe("done");
  });

  it("should skip review when skipReview=true in full pipeline from planning", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skip-review-full",
        projectId: "test-project",
        title: "Full pipeline skip review",
        status: "planning",
        skipReview: true,
      })
      .run();

    await pollAndProcess();

    expect(runPlanner).toHaveBeenCalledWith("task-skip-review-full", "/tmp/test");
    expect(runImplementer).toHaveBeenCalledWith("task-skip-review-full", "/tmp/test");
    expect(runReviewer).not.toHaveBeenCalled();
    const task = db.select().from(tasks).where(eq(tasks.id, "task-skip-review-full")).get();
    expect(task!.status).toBe("done");
  });

  it("should preserve reviewIterationCount across rework cycles until max iterations", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-rework-iter",
        projectId: "test-project",
        title: "Rework iteration tracking",
        status: "review",
        autoMode: true,
        reviewComments: "## Code Review\n- fix issue A",
        maxReviewIterations: 3,
      })
      .run();

    // --- Cycle 1: reviewer completes, gate requests rework ---
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "rework_requested",
      currentIteration: 1,
      metrics: {
        strategy: "full_re_review",
        iteration: 1,
        previousBlockingCount: 0,
        stillBlockingCount: 0,
        newBlockingCount: 1,
        totalBlockingCount: 1,
        parserMode: "structured",
      },
      autoReviewState: {
        strategy: "full_re_review",
        iteration: 1,
        findings: [{ id: "fix-a", source: "code_review", text: "fix issue A" }],
      },
    });
    await pollAndProcess();

    let task = db.select().from(tasks).where(eq(tasks.id, "task-rework-iter")).get();
    expect(task!.status).toBe("implementing");
    expect(task!.reworkRequested).toBe(true);
    expect(task!.reviewIterationCount).toBe(1);

    // --- Cycle 2: implementer completes, task moves to review (count must survive) ---
    vi.clearAllMocks();
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "rework_requested",
      currentIteration: 2,
      metrics: {
        strategy: "full_re_review",
        iteration: 2,
        previousBlockingCount: 1,
        stillBlockingCount: 1,
        newBlockingCount: 0,
        totalBlockingCount: 1,
        parserMode: "structured",
      },
      autoReviewState: {
        strategy: "full_re_review",
        iteration: 2,
        findings: [{ id: "fix-a", source: "code_review", text: "fix issue A" }],
      },
    });
    await pollAndProcess();

    task = db.select().from(tasks).where(eq(tasks.id, "task-rework-iter")).get();
    // After implementer→review→gate rework: count should be 2 now
    expect(task!.status).toBe("implementing");
    expect(task!.reworkRequested).toBe(true);
    expect(task!.reviewIterationCount).toBe(2);

    // --- Cycle 3: implementer completes, reviewer runs, gate hits max iterations ---
    vi.clearAllMocks();
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "manual_review_required",
      currentIteration: 3,
      handoffReason: "max_iterations",
      metrics: {
        strategy: "full_re_review",
        iteration: 3,
        previousBlockingCount: 1,
        stillBlockingCount: 1,
        newBlockingCount: 0,
        totalBlockingCount: 1,
        parserMode: "structured",
      },
      autoReviewState: {
        strategy: "full_re_review",
        iteration: 3,
        findings: [{ id: "fix-a", source: "code_review", text: "fix issue A" }],
      },
    });
    await pollAndProcess();

    task = db.select().from(tasks).where(eq(tasks.id, "task-rework-iter")).get();
    expect(task!.status).toBe("review");
    expect(task!.executionOwner).toBe("human");
    expect(task!.ownershipRevision).toBe(1);
    expect(task!.manualReviewRequired).toBe(true);
    expect(task!.reviewIterationCount).toBe(3);
    expect(task!.autoReviewStateJson).toContain("fix-a");
    expect(
      db
        .select()
        .from(taskExecutorHistory)
        .where(eq(taskExecutorHistory.taskId, "task-rework-iter"))
        .get(),
    ).toMatchObject({
      executionOwner: "human",
      actorKind: "system",
      actorId: "auto-review-gate",
      reason: "max_iterations",
    });
    expect(
      db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.taskId, "task-rework-iter"))
        .all()
        .some((event) => event.action === "task.execution_handoff"),
    ).toBe(true);
  });

  it("should reset reviewIterationCount to 0 for non-implementer stage transitions", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-reset-count",
        projectId: "test-project",
        title: "Reset count on planning",
        status: "planning",
        reviewIterationCount: 5,
      })
      .run();

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-reset-count")).get();
    expect(task!.status).toBe("done");
    expect(task!.reviewIterationCount).toBe(0);
  });

  it("should pass reworkRequested=true to implementer during rework and reset after", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-rework-flag",
        projectId: "test-project",
        title: "Rework flag lifecycle",
        status: "review",
        autoMode: true,
        reviewComments: "## Code Review\n- fix issue A",
      })
      .run();

    // Cycle 1: reviewer → gate requests rework
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "rework_requested",
      currentIteration: 1,
      metrics: {
        strategy: "full_re_review",
        iteration: 1,
        previousBlockingCount: 0,
        stillBlockingCount: 0,
        newBlockingCount: 1,
        totalBlockingCount: 1,
        parserMode: "structured",
      },
      autoReviewState: {
        strategy: "full_re_review",
        iteration: 1,
        findings: [{ id: "fix-a", source: "code_review", text: "fix issue A" }],
      },
    });
    await pollAndProcess();

    let task = db.select().from(tasks).where(eq(tasks.id, "task-rework-flag")).get();
    expect(task!.status).toBe("implementing");
    expect(task!.reworkRequested).toBe(true);

    // Cycle 2: capture reworkRequested inside implementer execution
    let reworkDuringExec: boolean | undefined;
    vi.mocked(runImplementer).mockImplementationOnce(async (taskId) => {
      const t = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      reworkDuringExec = t?.reworkRequested;
    });
    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce({
      status: "accepted",
      currentIteration: 2,
      metrics: {
        strategy: "full_re_review",
        iteration: 2,
        previousBlockingCount: 1,
        stillBlockingCount: 0,
        newBlockingCount: 0,
        totalBlockingCount: 0,
        parserMode: "structured",
      },
      autoReviewState: null,
    });
    await pollAndProcess();

    // Implementer must see reworkRequested=true during execution
    expect(reworkDuringExec).toBe(true);

    // After full cycle (implementer→review→accepted→done), reworkRequested is reset
    task = db.select().from(tasks).where(eq(tasks.id, "task-rework-flag")).get();
    expect(task!.status).toBe("done");
    expect(task!.reworkRequested).toBe(false);
  });

  it("should do nothing when no tasks exist", async () => {
    await pollAndProcess();

    expect(runPlanner).not.toHaveBeenCalled();
    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it("should set intermediate status during processing", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-6",
        projectId: "test-project",
        title: "Intermediate",
        status: "planning",
      })
      .run();

    // Track status changes during planner execution
    let statusDuringExec: string | undefined;
    vi.mocked(runPlanner).mockImplementationOnce(async () => {
      const t = db.select().from(tasks).where(eq(tasks.id, "task-6")).get();
      statusDuringExec = t?.status;
    });

    await pollAndProcess();

    expect(statusDuringExec).toBe("planning");
  });

  // ── Parallel mode per-project tests ───────────────────────

  it("should process multiple tasks concurrently for parallel-enabled project", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({
        id: "parallel-proj",
        name: "Parallel",
        rootPath: "/tmp/parallel",
        parallelEnabled: true,
      })
      .run();
    db.insert(tasks)
      .values({ id: "p-task-1", projectId: "parallel-proj", title: "T1", status: "planning" })
      .run();
    db.insert(tasks)
      .values({ id: "p-task-2", projectId: "parallel-proj", title: "T2", status: "planning" })
      .run();

    await pollAndProcess();

    // Both tasks should have been picked up by planner
    expect(runPlanner).toHaveBeenCalledWith("p-task-1", "/tmp/parallel");
    expect(runPlanner).toHaveBeenCalledWith("p-task-2", "/tmp/parallel");
  });

  it("should serialize branch-isolated parallel projects while task worktrees are disabled", async () => {
    const db = testDb.current;
    const rootPath = createGitTestRoot("coordinator-branch-isolated-").rootPath;

    db.insert(projects)
      .values({
        id: "parallel-branch-proj",
        name: "Parallel Branch",
        rootPath,
        parallelEnabled: true,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "branch-task-1",
        projectId: "parallel-branch-proj",
        title: "T1",
        status: "planning",
      })
      .run();
    db.insert(tasks)
      .values({
        id: "branch-task-2",
        projectId: "parallel-branch-proj",
        title: "T2",
        status: "planning",
      })
      .run();

    await pollAndProcess();

    const plannerCalls = (runPlanner as any).mock.calls.filter(
      ([, calledRoot]: [string, string]) => calledRoot === rootPath,
    );
    expect(plannerCalls).toHaveLength(1);
  });

  it("should preserve parallel execution for a non-auto-queue project sharing one Git worktree", async () => {
    const db = testDb.current;
    const rootPath = createGitTestRoot("coordinator-manual-shared-git-", {
      configYaml: "git:\n  create_branches: false\n",
    }).rootPath;

    db.insert(projects)
      .values({
        id: "parallel-manual-git",
        name: "Parallel Manual Git",
        rootPath,
        parallelEnabled: true,
        autoQueueMode: false,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "manual-git-task-1",
        projectId: "parallel-manual-git",
        title: "T1",
        status: "planning",
      })
      .run();
    db.insert(tasks)
      .values({
        id: "manual-git-task-2",
        projectId: "parallel-manual-git",
        title: "T2",
        status: "planning",
      })
      .run();

    await pollAndProcess();

    const plannerCalls = (runPlanner as any).mock.calls.filter(
      ([, calledRoot]: [string, string]) => calledRoot === rootPath,
    );
    expect(plannerCalls).toHaveLength(2);
  });

  it("should process only 1 task at a time for non-parallel project", async () => {
    const db = testDb.current;
    // test-project is non-parallel (default)
    db.insert(tasks)
      .values({ id: "s-task-1", projectId: "test-project", title: "S1", status: "planning" })
      .run();
    db.insert(tasks)
      .values({ id: "s-task-2", projectId: "test-project", title: "S2", status: "planning" })
      .run();

    await pollAndProcess();

    // Only the first task should complete the full pipeline (serial)
    const t1 = db.select().from(tasks).where(eq(tasks.id, "s-task-1")).get();
    const t2 = db.select().from(tasks).where(eq(tasks.id, "s-task-2")).get();
    expect(t1!.status).toBe("done");
    // Second task either untouched or partially progressed but not both done
    expect(t2!.status).not.toBe("done");
  });

  it("should force full mode via API for parallel project", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "par-proj", name: "Par", rootPath: "/tmp/par", parallelEnabled: true })
      .run();

    // Verify project was created with parallel enabled
    const proj = db.select().from(projects).where(eq(projects.id, "par-proj")).get();
    expect(proj!.parallelEnabled).toBe(true);
  });

  it("should respect per-project task cap for a parallel-enabled project", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "cap-proj", name: "Cap", rootPath: "/tmp/cap", parallelEnabled: true })
      .run();

    // Create 5 tasks in planning — per-project cap is 3, so at most 3 should be picked
    for (let i = 1; i <= 5; i++) {
      db.insert(tasks)
        .values({ id: `cap-task-${i}`, projectId: "cap-proj", title: `C${i}`, status: "planning" })
        .run();
    }

    await pollAndProcess();

    // Semaphore should have released all slots after allSettled
    expect(getStageSemaphore().totalActive()).toBe(0);

    // At most the per-project cap (3) planner calls should have been made
    const plannerCalls = (runPlanner as any).mock.calls.length;
    expect(plannerCalls).toBeLessThanOrEqual(3);
    expect(plannerCalls).toBeGreaterThanOrEqual(1);
  });

  it("should preserve the global task safety cap across project lanes", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT:
        coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };

    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 2,
      COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT: 2,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 2,
    });

    try {
      for (let projectIndex = 1; projectIndex <= 2; projectIndex++) {
        const projectId = `global-cap-project-${projectIndex}`;
        db.insert(projects)
          .values({
            id: projectId,
            name: `Global cap ${projectIndex}`,
            rootPath: `/tmp/global-cap-${projectIndex}`,
            parallelEnabled: true,
          })
          .run();

        for (let taskIndex = 1; taskIndex <= 2; taskIndex++) {
          db.insert(tasks)
            .values({
              id: `global-cap-task-${projectIndex}-${taskIndex}`,
              projectId,
              title: `Task ${projectIndex}-${taskIndex}`,
              status: "planning",
            })
            .run();
        }
      }

      const startedProjectIds: string[] = [];
      const releasePlanners: Array<() => void> = [];
      let activePlanners = 0;
      let peakActivePlanners = 0;

      vi.mocked(runPlanner).mockImplementation((taskId) => {
        const projectId = taskId.startsWith("global-cap-task-1-")
          ? "global-cap-project-1"
          : "global-cap-project-2";
        startedProjectIds.push(projectId);
        activePlanners += 1;
        peakActivePlanners = Math.max(peakActivePlanners, activePlanners);

        if (startedProjectIds.length > 2) {
          activePlanners -= 1;
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          releasePlanners.push(() => {
            activePlanners -= 1;
            resolve();
          });
        });
      });

      const pollPromise = pollAndProcess();
      try {
        await vi.waitFor(() => expect(releasePlanners).toHaveLength(2));
        expect(new Set(startedProjectIds)).toEqual(
          new Set(["global-cap-project-1", "global-cap-project-2"]),
        );
        expect(peakActivePlanners).toBeLessThanOrEqual(2);
      } finally {
        for (const release of releasePlanners) release();
        await pollPromise;
      }

      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should not let a slow early stage in one project block review in another project", async () => {
    const db = testDb.current;
    db.insert(projects).values({ id: "slow-project", name: "Slow", rootPath: "/tmp/slow" }).run();
    db.insert(projects)
      .values({ id: "review-project", name: "Review", rootPath: "/tmp/review" })
      .run();
    db.insert(tasks)
      .values({
        id: "slow-planning-task",
        projectId: "slow-project",
        title: "Slow planning",
        status: "planning",
      })
      .run();
    db.insert(tasks)
      .values({
        id: "ready-review-task",
        projectId: "review-project",
        title: "Ready review",
        status: "review",
      })
      .run();

    let resolvePlanner: (() => void) | undefined;
    vi.mocked(runPlanner).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePlanner = resolve;
        }),
    );

    const pollPromise = pollAndProcess();
    while (!resolvePlanner) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    const reviewerStartedWhilePlannerPending = vi.mocked(runReviewer).mock.calls.length > 0;

    resolvePlanner();
    await pollPromise;

    expect(reviewerStartedWhilePlannerPending).toBe(true);
    expect(runReviewer).toHaveBeenCalledWith("ready-review-task", "/tmp/review");
  });

  it("should execute one coalesced follow-up cycle after an overlapping poll request", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({
        id: "active-cycle-project",
        name: "Active cycle",
        rootPath: "/tmp/active-cycle",
        parallelEnabled: true,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "active-cycle-planning-task",
        projectId: "active-cycle-project",
        title: "Slow planning",
        status: "planning",
      })
      .run();

    let resolvePlanner: (() => void) | undefined;
    vi.mocked(runPlanner).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePlanner = resolve;
        }),
    );

    const firstPoll = pollAndProcess();
    await vi.waitFor(() => expect(resolvePlanner).toBeTypeOf("function"));

    db.insert(projects)
      .values({
        id: "follow-up-project",
        name: "Follow-up",
        rootPath: "/tmp/follow-up",
      })
      .run();
    db.insert(tasks)
      .values({
        id: "follow-up-review-task",
        projectId: "follow-up-project",
        title: "Follow-up review",
        status: "review",
      })
      .run();

    const secondPoll = pollAndProcess();
    expect(secondPoll).toBe(firstPoll);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reviewerStartedBeforePlannerFinished = vi
      .mocked(runReviewer)
      .mock.calls.some(([taskId]) => taskId === "follow-up-review-task");

    resolvePlanner?.();
    await Promise.all([firstPoll, secondPoll]);

    expect(reviewerStartedBeforePlannerFinished).toBe(false);
    expect(runReviewer).toHaveBeenCalledWith("follow-up-review-task", "/tmp/follow-up");
  });

  it("should skip a candidate paused while waiting for a global permit", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };
    let releasePlanner: (() => void) | undefined;

    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 1,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 2,
    });

    try {
      db.insert(projects)
        .values({ id: "permit-holder-project", name: "Holder", rootPath: "/tmp/holder" })
        .run();
      db.insert(projects)
        .values({ id: "stale-candidate-project", name: "Stale", rootPath: "/tmp/stale" })
        .run();
      db.insert(tasks)
        .values({
          id: "permit-holder-task",
          projectId: "permit-holder-project",
          title: "Permit holder",
          status: "planning",
          createdAt: "2026-07-15T00:00:00.000Z",
        })
        .run();
      db.insert(tasks)
        .values({
          id: "stale-review-task",
          projectId: "stale-candidate-project",
          title: "Stale review",
          status: "review",
          createdAt: "2026-07-15T00:01:00.000Z",
        })
        .run();

      vi.mocked(runPlanner).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releasePlanner = resolve;
          }),
      );

      const pollPromise = pollAndProcess();
      await vi.waitFor(() => expect(releasePlanner).toBeTypeOf("function"));
      expect(getStageSemaphore().totalActive()).toBe(1);
      await vi.waitFor(() => expect(getStageSemaphore().waitingCount()).toBe(1));

      db.update(tasks).set({ paused: true }).where(eq(tasks.id, "stale-review-task")).run();

      releasePlanner?.();
      await pollPromise;

      expect(runReviewer).not.toHaveBeenCalledWith("stale-review-task", "/tmp/stale");
      expect(db.select().from(tasks).where(eq(tasks.id, "stale-review-task")).get()).toMatchObject({
        status: "review",
        paused: true,
      });
      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      releasePlanner?.();
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should skip a candidate handed to a human while waiting for a global permit", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };
    let releasePlanner: (() => void) | undefined;

    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 1,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 2,
    });

    try {
      db.insert(projects)
        .values({ id: "owner-holder-project", name: "Holder", rootPath: "/tmp/owner-holder" })
        .run();
      db.insert(projects)
        .values({ id: "owner-flip-project", name: "Flip", rootPath: "/tmp/owner-flip" })
        .run();
      db.insert(tasks)
        .values({
          id: "owner-holder-task",
          projectId: "owner-holder-project",
          title: "Permit holder",
          status: "planning",
          createdAt: "2026-07-15T00:00:00.000Z",
        })
        .run();
      db.insert(tasks)
        .values({
          id: "owner-flip-task",
          projectId: "owner-flip-project",
          title: "Owner flip",
          status: "review",
          createdAt: "2026-07-15T00:01:00.000Z",
        })
        .run();

      vi.mocked(runPlanner).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releasePlanner = resolve;
          }),
      );

      const pollPromise = pollAndProcess();
      await vi.waitFor(() => expect(releasePlanner).toBeTypeOf("function"));
      await vi.waitFor(() => expect(getStageSemaphore().waitingCount()).toBe(1));

      db.update(tasks)
        .set({ executionOwner: "human", ownershipRevision: 1 })
        .where(eq(tasks.id, "owner-flip-task"))
        .run();

      releasePlanner?.();
      await pollPromise;

      expect(runReviewer).not.toHaveBeenCalledWith("owner-flip-task", "/tmp/owner-flip");
      expect(db.select().from(tasks).where(eq(tasks.id, "owner-flip-task")).get()).toMatchObject({
        status: "review",
        executionOwner: "human",
        lockedBy: null,
      });
      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      releasePlanner?.();
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should re-evaluate the runtime gate after waiting for a global permit", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };
    let releasePlanner: (() => void) | undefined;
    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 1,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 2,
    });

    try {
      const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
      db.insert(projects)
        .values({ id: "runtime-holder-project", name: "Holder", rootPath: "/tmp/runtime-holder" })
        .run();
      db.insert(projects)
        .values({
          id: "runtime-waiter-project",
          name: "Waiter",
          rootPath: "/tmp/runtime-waiter",
          defaultReviewRuntimeProfileId: "runtime-wait-profile",
        })
        .run();
      insertRuntimeProfile({
        id: "runtime-wait-profile",
        projectId: "runtime-waiter-project",
        snapshot: {
          source: "sdk_event",
          status: "available",
          precision: "heuristic",
          checkedAt: "2026-07-15T00:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "runtime-wait-profile",
          primaryScope: "time",
          resetAt: null,
          retryAfterSeconds: null,
          warningThreshold: null,
          windows: [],
          providerMeta: null,
        },
      });
      db.insert(tasks)
        .values({
          id: "runtime-holder-task",
          projectId: "runtime-holder-project",
          title: "Runtime holder",
          status: "planning",
          createdAt: "2026-07-15T00:00:00.000Z",
        })
        .run();
      db.insert(tasks)
        .values({
          id: "runtime-waiter-task",
          projectId: "runtime-waiter-project",
          title: "Runtime waiter",
          status: "review",
          createdAt: "2026-07-15T00:01:00.000Z",
        })
        .run();
      vi.mocked(runPlanner).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releasePlanner = resolve;
          }),
      );

      const pollPromise = pollAndProcess();
      await vi.waitFor(() => expect(releasePlanner).toBeTypeOf("function"));
      await vi.waitFor(() => expect(getStageSemaphore().waitingCount()).toBe(1));

      db.update(runtimeProfiles)
        .set({
          runtimeLimitSnapshotJson: JSON.stringify({
            source: "sdk_event",
            status: "blocked",
            precision: "heuristic",
            checkedAt: new Date().toISOString(),
            providerId: "anthropic",
            runtimeId: "claude",
            profileId: "runtime-wait-profile",
            primaryScope: "time",
            resetAt,
            retryAfterSeconds: null,
            warningThreshold: null,
            windows: [{ scope: "time", resetAt }],
            providerMeta: null,
          }),
          runtimeLimitUpdatedAt: new Date().toISOString(),
        })
        .where(eq(runtimeProfiles.id, "runtime-wait-profile"))
        .run();

      releasePlanner?.();
      await pollPromise;

      expect(runReviewer).not.toHaveBeenCalledWith("runtime-waiter-task", "/tmp/runtime-waiter");
      expect(
        db.select().from(tasks).where(eq(tasks.id, "runtime-waiter-task")).get(),
      ).toMatchObject({
        status: "blocked_external",
        blockedFromStatus: "review",
      });
      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      releasePlanner?.();
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should release the global permit and unblock a queued lane when task claim throws", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };
    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 1,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 2,
    });

    try {
      db.insert(projects)
        .values({ id: "queued-claim-project", name: "Queued claim", rootPath: "/tmp/queued" })
        .run();
      db.insert(tasks)
        .values({
          id: "throwing-claim-task",
          projectId: "test-project",
          title: "Throwing claim",
          status: "planning",
          createdAt: "2026-07-15T00:00:00.000Z",
        })
        .run();
      db.insert(tasks)
        .values({
          id: "queued-claim-task",
          projectId: "queued-claim-project",
          title: "Queued claim",
          status: "planning",
          createdAt: "2026-07-15T00:01:00.000Z",
        })
        .run();
      claimCoordinatorTaskIfEligibleMock.mockImplementationOnce(() => {
        throw new Error("claim failed");
      });

      await pollAndProcess();

      expect(runPlanner).toHaveBeenCalledWith("queued-claim-task", "/tmp/queued");
      expect(getStageSemaphore().totalActive()).toBe(0);
      expect(getStageSemaphore().trackedKeyCount()).toBe(0);

      await pollAndProcess();

      expect(runPlanner).toHaveBeenCalledWith("throwing-claim-task", "/tmp/test");
      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should drain started lane tasks before propagating a later candidate setup failure", async () => {
    const db = testDb.current;
    const coordinatorEnv = getEnv();
    const previousLimits = {
      COORDINATOR_MAX_CONCURRENT_TASKS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS,
      COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT:
        coordinatorEnv.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: coordinatorEnv.COORDINATOR_MAX_CONCURRENT_PROJECTS,
    };
    let releasePlanner: (() => void) | undefined;
    let pollPromise: Promise<void> | undefined;

    Object.assign(coordinatorEnv, {
      COORDINATOR_MAX_CONCURRENT_TASKS: 2,
      COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT: 2,
      COORDINATOR_MAX_CONCURRENT_PROJECTS: 1,
    });

    try {
      db.update(projects)
        .set({ parallelEnabled: true })
        .where(eq(projects.id, "test-project"))
        .run();
      db.insert(tasks)
        .values([
          {
            id: "lane-drain-planning-1",
            projectId: "test-project",
            title: "Running planner",
            status: "planning",
            createdAt: "2026-07-16T00:00:00.000Z",
          },
          {
            id: "lane-drain-planning-2",
            projectId: "test-project",
            title: "Throwing setup",
            status: "planning",
            createdAt: "2026-07-16T00:01:00.000Z",
          },
          {
            id: "lane-drain-review",
            projectId: "test-project",
            title: "Later review",
            status: "review",
            createdAt: "2026-07-16T00:02:00.000Z",
          },
        ])
        .run();

      vi.mocked(runPlanner).mockImplementation((taskId) => {
        if (taskId !== "lane-drain-planning-1") return Promise.resolve();
        return new Promise<void>((resolve) => {
          releasePlanner = resolve;
        });
      });

      const actualClaim = claimCoordinatorTaskIfEligibleMock.getMockImplementation();
      if (!actualClaim) throw new Error("Expected real coordinator claim implementation");
      claimCoordinatorTaskIfEligibleMock
        .mockImplementationOnce(actualClaim)
        .mockImplementationOnce(() => {
          throw new Error("second candidate claim failed");
        });

      let pollSettled = false;
      pollPromise = pollAndProcess();
      void pollPromise.finally(() => {
        pollSettled = true;
      });

      await vi.waitFor(() => expect(releasePlanner).toBeTypeOf("function"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pollSettled).toBe(false);

      const overlappingPoll = pollAndProcess();
      expect(overlappingPoll).toBe(pollPromise);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runReviewer).not.toHaveBeenCalledWith("lane-drain-review", "/tmp/test");

      releasePlanner?.();
      await Promise.all([pollPromise, overlappingPoll]);

      await pollAndProcess();

      expect(runReviewer).toHaveBeenCalledWith("lane-drain-review", "/tmp/test");
      expect(getStageSemaphore().totalActive()).toBe(0);
    } finally {
      releasePlanner?.();
      if (pollPromise) await pollPromise;
      Object.assign(coordinatorEnv, previousLimits);
    }
  });

  it("should release an owner claim when the claim path throws after writing the lock", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "post-write-claim-error",
        projectId: "test-project",
        title: "Post-write claim error",
        status: "planning",
      })
      .run();

    const actualClaim = claimCoordinatorTaskIfEligibleMock.getMockImplementation();
    if (!actualClaim) throw new Error("Expected real coordinator claim implementation");
    let claimWasWritten = false;
    claimCoordinatorTaskIfEligibleMock.mockImplementationOnce((...args) => {
      claimWasWritten = actualClaim(...args) != null;
      throw new Error("claim result conversion failed");
    });

    await pollAndProcess();

    expect(claimWasWritten).toBe(true);
    expect(
      db.select().from(tasks).where(eq(tasks.id, "post-write-claim-error")).get(),
    ).toMatchObject({
      lockedBy: null,
      lockedUntil: null,
    });
    expect(getStageSemaphore().totalActive()).toBe(0);
  });

  it("should start one task in each independent project lane beyond the per-project task cap", async () => {
    const db = testDb.current;
    for (let i = 1; i <= 4; i++) {
      db.insert(projects)
        .values({ id: `lane-project-${i}`, name: `Lane ${i}`, rootPath: `/tmp/lane-${i}` })
        .run();
      db.insert(tasks)
        .values({
          id: `lane-task-${i}`,
          projectId: `lane-project-${i}`,
          title: `Lane task ${i}`,
          status: "planning",
        })
        .run();
    }

    const startedTaskIds: string[] = [];
    const releasePlanners: Array<() => void> = [];
    vi.mocked(runPlanner).mockImplementation(
      (taskId) =>
        new Promise<void>((resolve) => {
          startedTaskIds.push(taskId);
          releasePlanners.push(resolve);
        }),
    );

    const pollPromise = pollAndProcess();
    try {
      await vi.waitFor(() => expect(releasePlanners).toHaveLength(4));

      for (let i = 1; i <= 4; i++) {
        expect(startedTaskIds).toContain(`lane-task-${i}`);
      }
    } finally {
      for (const release of releasePlanners) release();
      await pollPromise;
    }
  });
});
