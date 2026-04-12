import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeExecutionError } from "@aif/runtime";

const { mockWarn, mockError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("@aif/data", () => ({
  appendTaskActivityLog: vi.fn(),
}));

// Stable backoff for deterministic assertions
vi.mock("../taskWatchdog.js", () => ({
  getRandomBackoffMinutes: () => 10,
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    logger: () => ({
      warn: mockWarn,
      error: mockError,
      info: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const { classifyStageError } = await import("../stageErrorHandler.js");
import { appendTaskActivityLog } from "@aif/data";

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    stageLabel: "implementer",
    sourceStatus: "plan_ready" as const,
    retryCount: 0,
    err: new Error("boom"),
    ...overrides,
  };
}

describe("classifyStageError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- fast_retry ---

  it("returns fast_retry for stream interruption before worker dispatch", () => {
    const result = classifyStageError(
      makeInput({ err: new Error("stream interrupted before implement-worker dispatch") }),
    );
    expect(result).toEqual({ kind: "fast_retry" });
  });

  it("returns fast_retry for hook callback stream closed", () => {
    const result = classifyStageError(
      makeInput({ err: new Error("Error in hook callback: stream closed unexpectedly") }),
    );
    expect(result).toEqual({ kind: "fast_retry" });
  });

  it("logs warn with taskId, stage, and reason for fast_retry", () => {
    const err = new Error("stream interrupted before implement-worker dispatch");
    classifyStageError(makeInput({ err, stageLabel: "planner", taskId: "t-99" }));

    expect(mockWarn).toHaveBeenCalledOnce();
    const [meta, msg] = mockWarn.mock.calls[0];
    expect(meta).toMatchObject({
      taskId: "t-99",
      stage: "planner",
      reason: err.message,
    });
    expect(msg).toMatch(/transient stream interruption/i);
  });

  // --- blocked_external ---

  it("returns blocked_external for rate limit errors", () => {
    const result = classifyStageError(
      makeInput({ err: new RuntimeExecutionError("rate limit exceeded", undefined, "rate_limit") }),
    );
    expect(result.kind).toBe("blocked_external");
  });

  it("includes retryAfter ISO string for external failures", () => {
    const before = Date.now();
    const result = classifyStageError(
      makeInput({
        err: new RuntimeExecutionError("Usage limit exceeded", undefined, "rate_limit"),
      }),
    );

    expect(result.kind).toBe("blocked_external");
    if (result.kind === "blocked_external") {
      const retryMs = new Date(result.retryAfter).getTime();
      // 10 min backoff (mocked)
      expect(retryMs).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
      expect(retryMs).toBeLessThanOrEqual(before + 10 * 60_000 + 1000);
    }
  });

  it("increments retryCount from input", () => {
    const result = classifyStageError(
      makeInput({
        err: new RuntimeExecutionError("timeout", undefined, "timeout"),
        retryCount: 2,
      }),
    );
    expect(result.kind).toBe("blocked_external");
    if (result.kind === "blocked_external") {
      expect(result.retryCount).toBe(3);
    }
  });

  it("logs error with taskId, stage, retryAfter, and backoffMinutes for blocked_external", () => {
    const err = new RuntimeExecutionError("rate limit exceeded", undefined, "rate_limit");
    classifyStageError(makeInput({ err, taskId: "t-ext", stageLabel: "reviewer" }));

    expect(mockError).toHaveBeenCalledOnce();
    const [meta, msg] = mockError.mock.calls[0];
    expect(meta).toMatchObject({
      taskId: "t-ext",
      stage: "reviewer",
      backoffMinutes: 10,
    });
    expect(meta.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.err).toBe(err);
    expect(msg).toMatch(/external error/i);
  });

  it("writes activity log for external failure", () => {
    classifyStageError(
      makeInput({
        err: new RuntimeExecutionError("auth failed", undefined, "auth"),
        sourceStatus: "planning",
        stageLabel: "planner",
      }),
    );

    expect(appendTaskActivityLog).toHaveBeenCalledOnce();
    const logText = vi.mocked(appendTaskActivityLog).mock.calls[0][1];
    expect(logText).toContain("blocked_external");
    expect(logText).toContain("planning");
    expect(logText).toContain("planner");
  });

  // --- revert ---

  it("returns revert for unknown errors", () => {
    const result = classifyStageError(
      makeInput({ err: new Error("Cannot read property 'foo' of undefined") }),
    );
    expect(result).toEqual({ kind: "revert" });
  });

  it("returns revert for non-Error values", () => {
    const result = classifyStageError(makeInput({ err: 42 }));
    expect(result).toEqual({ kind: "revert" });
  });

  it("logs error with taskId, stage, and err for revert", () => {
    const err = new Error("unexpected null");
    classifyStageError(makeInput({ err, taskId: "t-rev", stageLabel: "planner" }));

    expect(mockError).toHaveBeenCalledOnce();
    const [meta, msg] = mockError.mock.calls[0];
    expect(meta).toMatchObject({
      taskId: "t-rev",
      stage: "planner",
      err,
    });
    expect(msg).toMatch(/reverting status/i);
  });

  it("does not write activity log for revert errors", () => {
    classifyStageError(makeInput({ err: new Error("internal bug") }));
    expect(appendTaskActivityLog).not.toHaveBeenCalled();
  });

  // --- priority: fast_retry beats external ---

  it("fast_retry takes priority over external match", () => {
    // "Error in hook callback: stream closed" matches both fast-retry and external patterns
    const result = classifyStageError(
      makeInput({ err: new Error("Error in hook callback: stream closed") }),
    );
    expect(result.kind).toBe("fast_retry");
  });
});
