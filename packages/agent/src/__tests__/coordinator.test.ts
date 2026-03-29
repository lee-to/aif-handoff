import { describe, it, expect, vi, beforeEach } from "vitest";
import { tasks, projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { eq } from "drizzle-orm";

// Set up test db
const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Mock subagent runners
vi.mock("../subagents/planner.js", () => ({
  runPlanner: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../reviewGate.js", () => ({
  evaluateReviewCommentsForAutoMode: vi.fn().mockResolvedValue({ status: "success" }),
}));
vi.mock("../autoReviewHandler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../autoReviewHandler.js")>();
  return {
    ...actual,
    handleAutoReviewGate: vi.fn().mockResolvedValue("accepted"),
  };
});

const { pollAndProcess, getCoordinatorRuntimeCounters, resetCoordinatorRuntimeCountersForTests } =
  await import("../coordinator.js");
const { runPlanner } = await import("../subagents/planner.js");
const { runPlanChecker } = await import("../subagents/planChecker.js");
const { runImplementer } = await import("../subagents/implementer.js");
const { runReviewer } = await import("../subagents/reviewer.js");
const { handleAutoReviewGate } = await import("../autoReviewHandler.js");

describe("coordinator", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    testDb.current
      .insert(projects)
      .values({ id: "test-project", name: "Test", rootPath: "/tmp/test" })
      .run();
    vi.clearAllMocks();
    resetCoordinatorRuntimeCountersForTests();
  });

  it("should pick up planning tasks and process through full pipeline", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({ id: "task-1", projectId: "test-project", title: "Plan me", status: "planning" })
      .run();

    await pollAndProcess();

    // Pipeline processes all three stages in one poll cycle
    expect(runPlanner).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runPlanChecker).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runImplementer).toHaveBeenCalledWith("task-1", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-1", "/tmp/test");
    const task = db.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(task!.status).toBe("done");
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
    const task = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(task!.status).toBe("done");
  });

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
      })
      .run();

    await pollAndProcess();

    expect(runPlanChecker).not.toHaveBeenCalled();
    expect(runImplementer).toHaveBeenCalledWith("task-impl", "/tmp/test");
    expect(runReviewer).toHaveBeenCalledWith("task-impl", "/tmp/test");
    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl")).get();
    expect(task!.status).toBe("done");
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

    vi.mocked(handleAutoReviewGate).mockResolvedValueOnce("rework_requested");

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
    const staleDate = new Date(Date.now() - 25 * 60_000).toISOString();
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
    expect(task!.blockedFromStatus).toBe("plan_ready");
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
    const staleDate = new Date(Date.now() - 25 * 60_000).toISOString();
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
    expect(task!.blockedFromStatus).toBe("plan_ready");
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
      new Error("Claude Code process exited with code 1"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-ext-1")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("planning");
    expect(task!.blockedReason).toContain("code 1");
    expect(task!.retryAfter).toBeTruthy();
    expect(task!.retryCount).toBe(1);
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
    expect(task!.status).toBe("plan_ready");
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
      new Error("Implementer blocked by permissions"),
    );

    await pollAndProcess();

    const task = db.select().from(tasks).where(eq(tasks.id, "task-impl-perm")).get();
    expect(task!.status).toBe("blocked_external");
    expect(task!.blockedFromStatus).toBe("plan_ready");
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
    expect(task!.status).toBe("plan_ready");
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
    expect(task!.status).toBe("plan_ready");
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
});
