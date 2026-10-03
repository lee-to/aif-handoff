import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects, tasks, getEnv } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import type { RuntimeRunInput, RuntimeRunResult } from "@aif/runtime";

const testDb = { current: createTestDb() };
const fakeRun = vi.fn<(input: RuntimeRunInput) => Promise<RuntimeRunResult>>();
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
vi.mock("@aif/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/runtime")>();
  return {
    ...actual,
    bootstrapRuntimeRegistry: async () =>
      actual.createRuntimeRegistry({
        logger: { debug: vi.fn(), warn: vi.fn() },
        builtInAdapters: [
          {
            descriptor: {
              id: "claude",
              providerId: "anthropic",
              displayName: "Fake runtime",
              capabilities: { ...actual.DEFAULT_RUNTIME_CAPABILITIES, supportsResume: true },
            },
            run: fakeRun,
            resume: fakeRun,
          },
        ],
      }),
  };
});
vi.mock("../notifier.js", () => ({
  notifyTaskBroadcast: vi.fn().mockResolvedValue(undefined),
  notifyProjectRuntimeLimitBroadcast: vi.fn().mockResolvedValue(undefined),
  notifyRuntimeUsageRefresh: vi.fn(),
}));

const {
  claimCoordinatorTaskIfEligible,
  findTaskById,
  releaseStaleTaskClaims,
  releaseTaskClaim,
  setTaskFields,
  updateTaskStatus,
  withTaskAttempt,
  SupersededTaskAttemptError,
} = await import("@aif/data");
const { executeSubagentQuery, setCoordinatorId, startHeartbeat } =
  await import("../subagentQuery.js");
const { setActiveStageAbortController, abortAllActiveStages } = await import("../stageAbort.js");
const { recoverStaleInProgressTasks, releaseDueBlockedTasks } = await import("../taskWatchdog.js");

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project", name: "Recovery", rootPath: "/tmp/fake-recovery" })
    .run();
  testDb.current
    .insert(tasks)
    .values({
      id: "task",
      projectId: "project",
      title: "Recovery",
      status: "planning",
      autoMode: false,
    })
    .run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fakeRun.mockReset();
  setCoordinatorId("fake-coordinator");
});
afterEach(() => {
  abortAllActiveStages();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function claim() {
  const task = claimCoordinatorTaskIfEligible({
    taskId: "task",
    expectedProjectId: "project",
    expectedStatus: "planning",
    coordinatorId: "fake-coordinator",
    lockDurationMs: 60_000,
  })!;
  return {
    taskId: task.id,
    attemptId: task.stageAttemptId!,
    coordinatorId: task.lockedBy!,
    ownershipRevision: task.ownershipRevision,
  };
}
function run() {
  return executeSubagentQuery({
    taskId: "task",
    projectRoot: "/tmp/fake-recovery",
    agentName: "fake-planner",
    prompt: "Plan",
    workflowKind: "planner",
  });
}

describe("runtime recovery contracts", () => {
  it.each([false, true])(
    "discards a late runtime result after retry (new attempt completed=%s)",
    async (completed) => {
      let finishOld!: (result: RuntimeRunResult) => void;
      let started!: () => void;
      const oldStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      fakeRun
        .mockImplementationOnce(async () => {
          started();
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        })
        .mockResolvedValueOnce({ outputText: "new plan", sessionId: "new-session", usage: null });
      const old = claim();
      // Observe rejection immediately; a superseded run must never persist its result.
      const oldOutcome = withTaskAttempt(old, run).then(
        (result) => result,
        (error: unknown) => error,
      );
      await oldStarted;
      vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);
      expect(releaseStaleTaskClaims()).toBe(1);
      recoverStaleInProgressTasks();
      const blocked = findTaskById("task")!;
      expect(blocked).toMatchObject({ status: "blocked_external", retryCount: 1 });
      vi.setSystemTime(new Date(blocked.retryAfter!));
      releaseDueBlockedTasks();
      const current = claim();
      expect(current.attemptId).not.toBe(old.attemptId);
      await withTaskAttempt(current, async () => {
        const result = await run();
        setTaskFields("task", { plan: result.resultText });
        if (completed) updateTaskStatus("task", "plan_ready", { retryCount: 0 });
      });
      if (completed) releaseTaskClaim("task", current.coordinatorId, current.attemptId);
      const beforeLateResult = findTaskById("task");
      finishOld({ outputText: "obsolete plan", sessionId: "old-session", usage: null });
      expect(await oldOutcome).toBeInstanceOf(SupersededTaskAttemptError);
      expect(findTaskById("task")).toEqual(beforeLateResult);
      expect(findTaskById("task")!.plan).toBe("new plan");
      expect(fakeRun).toHaveBeenCalledTimes(2);
    },
  );

  it("stops a superseded heartbeat without renewing or updating the newer attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const old = claim();
    withTaskAttempt(old, () => startHeartbeat("task"));
    releaseTaskClaim("task", old.coordinatorId, old.attemptId);
    const current = claim();
    const beforeOldHeartbeat = findTaskById("task");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(findTaskById("task")).toEqual(beforeOldHeartbeat);
    expect(vi.getTimerCount()).toBe(0);
    const timer = withTaskAttempt(current, () => startHeartbeat("task"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Date.parse(findTaskById("task")!.lastHeartbeatAt!)).toBe(Date.now());
    expect(Date.parse(findTaskById("task")!.lockedUntil!)).toBeGreaterThan(
      Date.parse(beforeOldHeartbeat!.lockedUntil!),
    );
    clearInterval(timer);
  });
});

it("does not restart a superseded runtime after its first-activity timeout and late success", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  let finishOld!: (result: RuntimeRunResult) => void;
  let started!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  fakeRun
    .mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    })
    .mockResolvedValue({ outputText: "unwanted retry", usage: null });
  const old = claim();
  const oldController = new AbortController();
  const oldOutcome = withTaskAttempt(old, () => {
    setActiveStageAbortController("task", oldController);
    return run().catch((error: unknown) => error);
  });
  await oldStarted;
  await vi.advanceTimersByTimeAsync(getEnv().AGENT_FIRST_ACTIVITY_TIMEOUT_MS + 1);
  expect(fakeRun.mock.calls[0][0].execution?.abortController?.signal.aborted).toBe(true);
  releaseTaskClaim("task", old.coordinatorId, old.attemptId);
  const current = claim();
  const currentController = new AbortController();
  withTaskAttempt(current, () => setActiveStageAbortController("task", currentController));
  const beforeLateResult = findTaskById("task");
  finishOld({ outputText: "late old result", usage: null });
  expect(await oldOutcome).toBeInstanceOf(SupersededTaskAttemptError);
  expect(fakeRun).toHaveBeenCalledTimes(1);
  expect(currentController.signal.aborted).toBe(false);
  expect(findTaskById("task")).toEqual(beforeLateResult);
});
