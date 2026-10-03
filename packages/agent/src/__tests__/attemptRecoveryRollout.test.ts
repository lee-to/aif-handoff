import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects, tasks } from "@aif/shared";

const rollout = vi.hoisted(() => ({ enabled: false }));
const planner = vi.hoisted(() => vi.fn());
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
vi.mock("../subagents/implementer.js", () => ({ runImplementer: vi.fn() }));
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
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project", name: "Rollout", rootPath: "/tmp/fake-rollout" })
    .run();
});
afterEach(() => vi.restoreAllMocks());

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
        expect(claimed.stageStartedAt).toBeNull();
      }
    });
    await pollAndProcess();
    expect(planner).toHaveBeenCalledTimes(1);
    expect(repo.findTaskById("run")!.status).toBe("plan_ready");
    expect(repo.getTaskAttempt()).toBeUndefined();

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
    expect(repo.findTaskById("retry")!.status).toBe(enabled ? "planning" : "blocked_external");

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
    expect(claimed.updatedAt).toBe(enabled ? claimed.stageStartedAt : baseline);
    expect(claimed.lastHeartbeatAt).toBe(enabled ? claimed.stageStartedAt : baseline);
  },
);
