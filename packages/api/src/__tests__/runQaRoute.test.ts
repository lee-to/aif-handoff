import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { projects, tasks, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

// QA routes are gated behind AIF_QA_PIPELINE_ENABLED (off by default). Enable it
// before importing the route module — schemas.ts calls getEnv() at schema-definition
// time, which caches the parsed env. The disabled-flag case below toggles it back.
process.env.AIF_QA_PIPELINE_ENABLED = "true";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../ws.js", () => ({
  broadcast: vi.fn(),
  setupWebSocket: vi.fn(() => ({ injectWebSocket: vi.fn(), upgradeWebSocket: vi.fn() })),
  getInjectWebSocket: vi.fn(),
}));

// Prevent the fire-and-forget runner from executing the real runtime.
const mockRunQaQuery = vi.fn();
vi.mock("../services/qaRunner.js", () => ({
  runQaQuery: (...args: unknown[]) => mockRunQaQuery(...args),
}));
const mockRunQaCheckQuery = vi.fn();
vi.mock("../services/qaCheckRunner.js", () => ({
  runQaCheckQuery: (...args: unknown[]) => mockRunQaCheckQuery(...args),
}));

const { tasksRouter } = await import("../routes/tasks.js");

function createApp() {
  const app = new Hono();
  app.route("/tasks", tasksRouter);
  return app;
}

function seedTask(overrides: Record<string, unknown> = {}) {
  const db = testDb.current;
  db.insert(projects).values({ id: "p1", name: "P1", rootPath: "/tmp/p1" }).run();
  db.insert(tasks)
    .values({
      id: "t1",
      projectId: "p1",
      title: "Task 1",
      branchName: "feature/foo",
      qaStatus: "idle",
      ...overrides,
    })
    .run();
}

describe("POST /tasks/:id/run-qa", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockRunQaQuery.mockReset();
    mockRunQaQuery.mockResolvedValue({ ok: true });
    mockRunQaCheckQuery.mockReset();
    mockRunQaCheckQuery.mockResolvedValue({ ok: true });
  });

  it("returns 404 when task not found", async () => {
    const res = await app.request("/tasks/missing/run-qa", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when project not found", async () => {
    testDb.current
      .insert(tasks)
      .values({ id: "t1", projectId: "ghost", title: "T", branchName: "feature/foo" })
      .run();
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when QA already running", async () => {
    seedTask({ qaStatus: "running" });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(409);
    expect(mockRunQaQuery).not.toHaveBeenCalled();
  });

  it("serializes concurrent starts: a second POST gets 409 (atomic running claim)", async () => {
    seedTask(); // qaStatus idle
    const first = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(first.status).toBe(202);
    // The first request synchronously claimed qaStatus:"running" via the
    // compare-and-set; the mocked runner never resets it, mirroring an in-flight
    // run. A second POST must lose the claim and not start a duplicate run.
    const second = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(second.status).toBe(409);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledTimes(1);
  });

  it("releases the running claim with qaStatus error when the dispatch throws", async () => {
    seedTask(); // qaStatus idle
    // runQaQuery is contracted never to throw, but the dispatch guard must
    // survive a contract breach (or a failing dynamic import): persist a
    // terminal qaStatus so the atomic claim does not stay stuck on "running"
    // and block every future QA start for the task.
    mockRunQaQuery.mockRejectedValue(new Error("dispatch boom"));
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    const row = testDb.current
      .select()
      .from(tasks)
      .all()
      .find((t) => t.id === "t1");
    expect(row?.qaStatus).toBe("error");
    // Slot released — a follow-up manual run can claim it again.
    mockRunQaQuery.mockResolvedValue({ ok: true });
    const retry = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(retry.status).toBe(202);
  });

  it("returns 202 for a branchless task (runner resolves the branch via git)", async () => {
    seedTask({ branchName: null });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });

  it("returns 202 and triggers the runner on a valid request", async () => {
    seedTask();
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    // Fire-and-forget: allow the async import + invocation to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });

  it("uses worktreePath as executionRoot when present", async () => {
    seedTask({ worktreePath: "/tmp/wt/t1" });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/wt/t1",
    });
  });

  it("chains QA Check after a successful QA run when autoQaCheck is enabled", async () => {
    seedTask({ autoQaCheck: true, qaTestCases: "# Test Cases" });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRunQaCheckQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });

  it("returns 403 with feature_disabled when AIF_QA_PIPELINE_ENABLED is off", async () => {
    seedTask();
    process.env.AIF_QA_PIPELINE_ENABLED = "false";
    resetEnvCache();
    try {
      const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("feature_disabled");
      expect(mockRunQaQuery).not.toHaveBeenCalled();
    } finally {
      process.env.AIF_QA_PIPELINE_ENABLED = "true";
      resetEnvCache();
    }
  });
});

describe("POST /tasks/:id/run-qa-check", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockRunQaQuery.mockReset();
    mockRunQaQuery.mockResolvedValue({ ok: true });
    mockRunQaCheckQuery.mockReset();
    mockRunQaCheckQuery.mockResolvedValue({ ok: true });
  });

  it("requires test cases produced by QA", async () => {
    seedTask({ qaTestCases: null });

    const res = await app.request("/tasks/t1/run-qa-check", { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "qa_test_cases_required" });
    expect(mockRunQaCheckQuery).not.toHaveBeenCalled();
  });

  it("atomically starts an independent QA Check run", async () => {
    seedTask({ qaTestCases: "# Test Cases" });

    const first = await app.request("/tasks/t1/run-qa-check", { method: "POST" });
    const second = await app.request("/tasks/t1/run-qa-check", { method: "POST" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRunQaCheckQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });
});
