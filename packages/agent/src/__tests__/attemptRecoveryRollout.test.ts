import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects, tasks } from "@aif/shared";

const rollout = vi.hoisted(() => ({ enabled: false }));
const planner = vi.hoisted(() => vi.fn());
const implementer = vi.hoisted(() => vi.fn());
const testDb = { current: createTestDb() };
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), AIF_AGENT_ATTEMPT_RECOVERY_ENABLED: rollout.enabled }),
  };
});
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});
vi.mock("../subagents/planner.js", () => ({ runPlanner: planner }));
vi.mock("../subagents/improver.js", () => ({ runImprover: vi.fn() }));
vi.mock("../subagents/planChecker.js", () => ({ runPlanChecker: vi.fn() }));
vi.mock("../subagents/implementer.js", () => ({ runImplementer: implementer }));
vi.mock("../subagents/reviewer.js", () => ({ runReviewer: vi.fn() }));
vi.mock("../subagents/verifier.js", () => ({ runVerifier: vi.fn() }));
vi.mock("../subagentQuery.js", () => ({
  setCoordinatorId: vi.fn(),
  executeSubagentQuery: vi.fn(() => {
    throw new Error("Unexpected provider execution");
  }),
}));
vi.mock("../githubWorkflow.js", () => ({
  publishGitHubTask: vi.fn(),
  synchronizeGitHubProjects: vi.fn(),
}));
vi.mock("../notifier.js", () => ({
  notifyTaskBroadcast: vi.fn(),
  notifyProjectBroadcast: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  planner.mockReset();
  implementer.mockReset();
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project", name: "Rollout", rootPath: "/tmp/fake-rollout" })
    .run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "initializes recovery=%s once and selects matching claim, execution, and watchdog behavior",
  async (enabled) => {
    rollout.enabled = enabled;
    const repo = await import("@aif/data");
    const { pollAndProcess } = await import("../coordinator.js");
    const watchdog = await import("../taskWatchdog.js");
    // Changes after initialization must not switch a running process between rollout modes.
    rollout.enabled = !enabled;
    expect(repo.isTaskAttemptRecoveryEnabled()).toBe(enabled);
    const baseline = new Date(Date.now() - 30_000).toISOString();
    testDb.current
      .insert(tasks)
      .values({
        id: "run",
        projectId: "project",
        title: "Run",
        status: "planning",
        autoMode: false,
        lastHeartbeatAt: baseline,
        updatedAt: baseline,
      })
      .run();
    planner.mockImplementationOnce(async () => {
      const claimed = repo.findTaskById("run")!;
      if (enabled) {
        expect(repo.getTaskAttempt()?.attemptId).toBe(claimed.stageAttemptId);
        expect(claimed.stageAttemptId).toEqual(expect.any(String));
        expect(claimed.stageStartedAt).toEqual(expect.any(String));
      } else {
        expect(repo.getTaskAttempt()).toBeUndefined();
        expect(claimed.stageAttemptId).toBeNull();
        expect(claimed.stageStartedAt).toEqual(expect.any(String));
      }
    });
    await pollAndProcess();
    expect(planner).toHaveBeenCalledTimes(1);
    expect(repo.findTaskById("run")!.status).toBe("plan_ready");
    expect(repo.getTaskAttempt()).toBeUndefined();
    expect(repo.findTaskById("run")!.stageStartedAt).toBeNull();
    repo.setTaskFields("run", { autoMode: true, skipReview: true });
    implementer.mockImplementationOnce(async () => {
      expect(repo.findTaskById("run")).toMatchObject({
        status: "implementing",
        stageStartedAt: expect.any(String),
      });
    });
    await pollAndProcess();
    expect(implementer).toHaveBeenCalledTimes(1);
    expect(repo.findTaskById("run")).toMatchObject({ status: "done", stageStartedAt: null });

    testDb.current
      .insert(tasks)
      .values({
        id: "retry",
        projectId: "project",
        title: "Retry",
        status: "blocked_external",
        blockedFromStatus: "planning",
        retryCount: 2,
        retryAfter: new Date(Date.now() - 1_000).toISOString(),
      })
      .run();
    watchdog.releaseDueBlockedTasks();
    expect(repo.findTaskById("retry")!.retryCount).toBe(enabled ? 2 : 0);
    repo.setTaskFields("retry", {
      lastHeartbeatAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
    });
    watchdog.recoverStaleInProgressTasks();
    expect(repo.findTaskById("retry")!.status).toBe("planning");

    testDb.current
      .insert(tasks)
      .values({
        id: "claim",
        projectId: "project",
        title: "Claim",
        status: "planning",
        lastHeartbeatAt: baseline,
        updatedAt: baseline,
      })
      .run();
    const claimed = repo.claimCoordinatorTaskIfEligible({
      taskId: "claim",
      expectedProjectId: "project",
      expectedStatus: "planning",
      coordinatorId: "coordinator",
      lockDurationMs: 60_000,
    })!;
    expect(claimed.stageAttemptId).toEqual(enabled ? expect.any(String) : null);
    expect(claimed.updatedAt).toBe(claimed.stageStartedAt);
    expect(claimed.lastHeartbeatAt).toBe(claimed.stageStartedAt);
  },
);

it.each([false, true])(
  "does not block or spend retries on an unclaimed review waiting behind a busy stage (recovery=%s)",
  async (enabled) => {
    rollout.enabled = enabled;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { getEnv } = await import("@aif/shared");
    const repo = await import("@aif/data");
    const { recoverStaleInProgressTasks } = await import("../taskWatchdog.js");
    const timeout = getEnv().AGENT_STAGE_STALE_TIMEOUT_MS;
    const baseline = new Date().toISOString();
    testDb.current
      .insert(tasks)
      .values([
        {
          id: "busy",
          projectId: "project",
          title: "Busy implementer",
          status: "implementing",
          updatedAt: baseline,
          lastHeartbeatAt: baseline,
        },
        {
          id: "queued",
          projectId: "project",
          title: "Queued review",
          status: "review",
          updatedAt: baseline,
          lastHeartbeatAt: baseline,
        },
      ])
      .run();
    expect(
      repo.claimCoordinatorTaskIfEligible({
        taskId: "busy",
        expectedProjectId: "project",
        expectedStatus: "implementing",
        coordinatorId: "coordinator",
        lockDurationMs: timeout * (getEnv().AGENT_STAGE_STALE_MAX_RETRY + 2),
      }),
    ).toBeDefined();
    const queued = repo.findTaskById("queued");

    for (let cycle = 0; cycle <= getEnv().AGENT_STAGE_STALE_MAX_RETRY; cycle++) {
      vi.setSystemTime(Date.now() + timeout + 1);
      recoverStaleInProgressTasks();
      expect(repo.findTaskById("queued")).toEqual(queued);
      expect(repo.findTaskById("busy")!.status).toBe("implementing");
    }
  },
);

it.each([false, true])(
  "recovers a claimed stage but leaves its next unclaimed stage queued (recovery=%s)",
  async (enabled) => {
    rollout.enabled = enabled;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { getEnv } = await import("@aif/shared");
    const repo = await import("@aif/data");
    const watchdog = await import("../taskWatchdog.js");
    testDb.current
      .insert(tasks)
      .values({
        id: "hung",
        projectId: "project",
        title: "Hung planner",
        status: "planning",
        updatedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      })
      .run();
    expect(
      repo.claimCoordinatorTaskIfEligible({
        taskId: "hung",
        expectedProjectId: "project",
        expectedStatus: "planning",
        coordinatorId: "coordinator",
        lockDurationMs: 60_000,
      }),
    ).toBeDefined();
    vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);
    repo.releaseStaleTaskClaims();
    watchdog.recoverStaleInProgressTasks();
    expect(repo.findTaskById("hung")).toMatchObject({
      status: "blocked_external",
      blockedFromStatus: "planning",
      retryCount: 1,
    });
    vi.setSystemTime(new Date(repo.findTaskById("hung")!.retryAfter!));
    watchdog.releaseDueBlockedTasks();
    expect(
      repo.claimCoordinatorTaskIfEligible({
        taskId: "hung",
        expectedProjectId: "project",
        expectedStatus: "planning",
        coordinatorId: "coordinator",
        lockDurationMs: 60_000,
      }),
    ).toBeDefined();
    repo.updateTaskStatus("hung", "planning");
    expect(repo.findTaskById("hung")!.stageStartedAt).not.toBeNull();
    repo.updateTaskStatus("hung", "review");
    repo.releaseTaskClaim("hung", "coordinator");
    const queued = repo.findTaskById("hung");
    vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);
    watchdog.recoverStaleInProgressTasks();
    expect(repo.findTaskById("hung")).toEqual(queued);
  },
);

it.each([false, true])(
  "keeps work returned by handoff or replanning queued until its next claim (recovery=%s)",
  async (enabled) => {
    rollout.enabled = enabled;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { getEnv } = await import("@aif/shared");
    const repo = await import("@aif/data");
    const { recoverStaleInProgressTasks } = await import("../taskWatchdog.js");
    const actor = { kind: "system" as const, id: "operator", displayNameSnapshot: "Operator" };
    for (const reset of ["handoff", "replan"]) {
      testDb.current
        .insert(tasks)
        .values({
          id: reset,
          projectId: "project",
          title: reset,
          status: "plan_ready",
          updatedAt: new Date().toISOString(),
        })
        .run();
      expect(
        repo.claimCoordinatorTaskIfEligible({
          taskId: reset,
          expectedProjectId: "project",
          expectedStatus: "plan_ready",
          coordinatorId: "coordinator",
          lockDurationMs: 60_000,
        }),
      ).toBeDefined();
      repo.releaseTaskClaim(reset, "coordinator");
      if (reset === "handoff") {
        expect(
          repo.handoffTaskExecution({
            taskId: reset,
            executionOwner: "human",
            expectedOwnershipRevision: 0,
            actor,
          }).ok,
        ).toBe(true);
        expect(
          repo.handoffTaskExecution({
            taskId: reset,
            executionOwner: "ai",
            expectedOwnershipRevision: 1,
            actor,
          }).ok,
        ).toBe(true);
      } else {
        expect(
          repo.applyTaskAction({
            taskId: reset,
            event: "request_replanning",
            participantsModeEnabled: false,
            actor,
          }).ok,
        ).toBe(true);
      }
      const queued = repo.findTaskById(reset);
      vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);
      recoverStaleInProgressTasks();
      expect(repo.findTaskById(reset)).toEqual(queued);
    }
  },
);
