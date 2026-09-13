import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tasks, projects, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { eq } from "drizzle-orm";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Stub fetch so notifier broadcasts don't hit a real API.
const originalFetch = global.fetch;
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Hermetic env, captured by the coordinator at module load:
// - worktrees flag pinned so a container env (AIF_TASK_WORKTREES_ENABLED=true)
//   cannot flip project concurrency resolution mid-suite
// - per-project cap pinned to 1 so "free slots" is unambiguous: a project
//   either has its single slot free or it does not
process.env.AIF_TASK_WORKTREES_ENABLED = "false";
process.env.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT = "1";
resetEnvCache();

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
vi.mock("../autoReviewHandler.js", () => ({
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
}));

const { pollAndProcess, getStageSemaphore } = await import("../coordinator.js");
const { runPlanner } = await import("../subagents/planner.js");
const { runImplementer } = await import("../subagents/implementer.js");

// Processing-start evidence: the runner is invoked with the task's status
// captured at call time. Asserting on this (instead of a post-hoc status
// read) makes "processing started" deterministic even though mocked stages
// complete in microtasks.
const plannerStatusAtCall: Record<string, string> = {};
vi.mocked(runPlanner).mockImplementation(async (taskId: string) => {
  plannerStatusAtCall[taskId] = taskStatus(taskId) ?? "missing";
});

function seedProject(
  id: string,
  opts: { parallel?: boolean; autoQueue?: boolean; rootPath?: string } = {},
) {
  testDb.current
    .insert(projects)
    .values({
      id,
      name: id,
      rootPath: opts.rootPath ?? `/tmp/${id}`,
      parallelEnabled: opts.parallel ?? false,
      autoQueueMode: opts.autoQueue ?? false,
    })
    .run();
}

function seedTask(id: string, projectId: string, extras: Partial<typeof tasks.$inferInsert> = {}) {
  testDb.current
    .insert(tasks)
    .values({ id, projectId, title: id, status: "backlog", position: 100, ...extras })
    .run();
}

function taskStatus(id: string): string | undefined {
  return testDb.current.select().from(tasks).where(eq(tasks.id, id)).get()?.status;
}

/** Controlled gate: the hanging stage resolves only when the test says so. */
function createGate(): { promise: Promise<void>; resolve: () => void; isResolved: () => boolean } {
  let resolve!: () => void;
  let resolved = false;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      resolved = true;
      r();
    };
  });
  return { promise, resolve, isResolved: () => resolved };
}

/**
 * Freeze the world: hang the implementer stage for specific task ids (all
 * other implementer calls complete immediately). With both the busy lane and
 * the admitted task parked mid-stage, every mid-cycle assertion below is
 * stable — nothing can progress until the test releases the gates.
 */
function hangImplementerFor(...taskIds: string[]): Map<string, ReturnType<typeof createGate>> {
  const gates = new Map(taskIds.map((id) => [id, createGate()]));
  vi.mocked(runImplementer).mockImplementation(async (taskId: string) => {
    const gate = gates.get(taskId);
    if (gate) await gate.promise;
  });
  return gates;
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("mid-cycle admission", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.clearAllMocks();
    for (const key of Object.keys(plannerStatusAtCall)) delete plannerStatusAtCall[key];
    getStageSemaphore().reset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("starts processing a parallel project's backlog task while another project's lane is mid-pass", async () => {
    // Project A holds the poll cycle open: its implementer stage never settles.
    seedProject("busy-proj", { parallel: true, rootPath: "/tmp/busy-root" });
    seedTask("a1", "busy-proj", { status: "plan_ready" });
    // Project B is parallel + auto-queue with its slot free, but EMPTY at
    // cycle start (the incident shape: work arrives mid-cycle). b1 is gated
    // too, so the admitted task stays observable mid-pipeline.
    seedProject("idle-proj", {
      parallel: true,
      autoQueue: true,
      rootPath: "/tmp/idle-root",
    });
    const gates = hangImplementerFor("a1", "b1");

    const cycle = pollAndProcess();
    await vi.waitFor(() => expect(runImplementer).toHaveBeenCalledWith("a1", "/tmp/busy-root"));

    // Work arrives on the idle project while the cycle is provably busy.
    seedTask("b1", "idle-proj", { position: 100 });
    seedTask("b2", "idle-proj", { position: 200 });

    // Scheduler tick / wake event lands during the active cycle.
    void pollAndProcess();

    // OUTCOME: b1 is admitted AND its planner actually runs mid-cycle (the
    // runner invocation with the task in `planning` is the processing-start
    // proof, not a status flip — T-ADM-B), while a1's lane is still mid-pass
    // (its gate is unresolved — the admission is not cycle-end luck).
    await vi.waitFor(() => expect(runPlanner).toHaveBeenCalledWith("b1", "/tmp/idle-root"));
    expect(plannerStatusAtCall["b1"]).toBe("planning");
    expect(gates.get("a1")!.isResolved()).toBe(false);

    // b1 progressed to a hung implementer: processing is real and ongoing.
    expect(taskStatus("b1")).toBe("implementing");
    // Per-project cap respected under the new path: with the cap pinned to 1,
    // b2 stays in backlog while b1 is in flight.
    expect(taskStatus("b2")).toBe("backlog");
    expect(getStageSemaphore().totalActive()).toBe(2);

    // Release both lanes; everything drains through the normal machinery.
    gates.get("a1")!.resolve();
    gates.get("b1")!.resolve();
    await cycle;
    await vi.waitFor(() => expect(taskStatus("a1")).toBe("done"));
    await vi.waitFor(() => expect(taskStatus("b1")).toBe("done"));
    await flushMicrotasks();
  });

  it("does not start a sequential project's next task mid-cycle", async () => {
    seedProject("busy-proj", { parallel: true, rootPath: "/tmp/busy-root" });
    seedTask("a1", "busy-proj", { status: "plan_ready" });
    // Sequential project with one task in flight and a human-started second
    // task waiting in planning (the manual start_ai shape from the incident).
    seedProject("seq-proj", { parallel: false, autoQueue: true, rootPath: "/tmp/seq-root" });
    seedTask("s1", "seq-proj", { status: "plan_ready" });
    // Parallel control project proving the admission pass itself ran.
    seedProject("ctrl-proj", {
      parallel: true,
      autoQueue: true,
      rootPath: "/tmp/ctrl-root",
    });
    const gates = hangImplementerFor("a1", "s1");

    const cycle = pollAndProcess();
    await vi.waitFor(() => expect(runImplementer).toHaveBeenCalledWith("s1", "/tmp/seq-root"));

    seedTask("s2", "seq-proj", { status: "planning" });
    seedTask("c1", "ctrl-proj");

    void pollAndProcess();

    // The pass ran (control project admitted mid-cycle)…
    await vi.waitFor(() => expect(runPlanner).toHaveBeenCalledWith("c1", "/tmp/ctrl-root"));
    expect(plannerStatusAtCall["c1"]).toBe("planning");
    // …but the sequential project's second task did NOT start while s1 is
    // mid-pass — sequential semantics stay owned by the serialized cycle.
    expect(runPlanner).not.toHaveBeenCalledWith("s2", "/tmp/seq-root");
    expect(taskStatus("s2")).toBe("planning");
    expect(gates.get("s1")!.isResolved()).toBe(false);

    gates.get("a1")!.resolve();
    gates.get("s1")!.resolve();
    await cycle;
    // After s1 drains, the follow-up cycle processes s2 — sequentially.
    await vi.waitFor(() => expect(taskStatus("s2")).toBe("done"));
    await flushMicrotasks();
  });

  it("keeps cycle-boundary admission when AGENT_MID_CYCLE_ADMISSION_ENABLED=false", async () => {
    vi.stubEnv("AGENT_MID_CYCLE_ADMISSION_ENABLED", "false");
    resetEnvCache();

    seedProject("busy-proj", { parallel: true, rootPath: "/tmp/busy-root" });
    seedTask("a1", "busy-proj", { status: "plan_ready" });
    seedProject("idle-proj", {
      parallel: true,
      autoQueue: true,
      rootPath: "/tmp/idle-root",
    });
    const gates = hangImplementerFor("a1");

    const cycle = pollAndProcess();
    await vi.waitFor(() => expect(runImplementer).toHaveBeenCalledWith("a1", "/tmp/busy-root"));

    seedTask("b1", "idle-proj");
    void pollAndProcess();
    // Give the would-be pass ample time to (wrongly) act.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Opt-out restores the pre-fix behavior: no mid-cycle admission while the
    // cycle is busy — b1 has not even been advanced out of backlog.
    expect(runPlanner).not.toHaveBeenCalledWith("b1", "/tmp/idle-root");
    expect(taskStatus("b1")).toBe("backlog");
    expect(gates.get("a1")!.isResolved()).toBe(false);

    vi.unstubAllEnvs();
    resetEnvCache();

    gates.get("a1")!.resolve();
    await cycle;
    // Normal cycling is intact: the follow-up cycle admits b1 after drain.
    await vi.waitFor(() => expect(taskStatus("b1")).toBe("done"));
    await flushMicrotasks();
  });
});
