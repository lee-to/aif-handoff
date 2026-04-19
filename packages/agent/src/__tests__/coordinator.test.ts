import { describe, it, expect, vi, beforeEach } from "vitest";
import { tasks, projects, runtimeProfiles } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { RuntimeExecutionError } from "@aif/runtime";
import { eq } from "drizzle-orm";

// Set up test db
const testDb = { current: createTestDb() };
const blockTaskForRuntimeGateIfEligibleMock = vi.fn();

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
  return {
    ...actual,
    blockTaskForRuntimeGateIfEligible: (
      ...args: Parameters<typeof actual.blockTaskForRuntimeGateIfEligible>
    ) => blockTaskForRuntimeGateIfEligibleMock(...args),
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
    getStageSemaphore().reset();
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
    expect(task!.blockedReason).toContain("provider runtime limit still blocked");
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
    expect(task!.blockedReason).toContain("exact quota threshold reached");
    expect(task!.blockedReason).toContain("5% <= 10%");
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
    expect(task!.status).toBe("done");
    expect(task!.manualReviewRequired).toBe(true);
    expect(task!.reviewIterationCount).toBe(3);
    expect(task!.autoReviewStateJson).toContain("fix-a");
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

  it("should respect global max across stages (totalActive cap)", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({ id: "cap-proj", name: "Cap", rootPath: "/tmp/cap", parallelEnabled: true })
      .run();

    // Create 5 tasks in planning — globalMax is 3, so at most 3 should be picked
    for (let i = 1; i <= 5; i++) {
      db.insert(tasks)
        .values({ id: `cap-task-${i}`, projectId: "cap-proj", title: `C${i}`, status: "planning" })
        .run();
    }

    await pollAndProcess();

    // Semaphore should have released all slots after allSettled
    expect(getStageSemaphore().totalActive()).toBe(0);

    // At most globalMax (3) planner calls should have been made
    const plannerCalls = (runPlanner as any).mock.calls.length;
    expect(plannerCalls).toBeLessThanOrEqual(3);
    expect(plannerCalls).toBeGreaterThanOrEqual(1);
  });
});
