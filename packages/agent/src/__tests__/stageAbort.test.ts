import { describe, it, expect, vi } from "vitest";

const attemptContext = { current: undefined as { attemptId: string } | undefined };
const mockReleaseTaskClaim = vi.fn();
vi.mock("@aif/data", () => ({
  getTaskAttempt: () => attemptContext.current,
  releaseTaskClaim: (...args: unknown[]) => mockReleaseTaskClaim(...args),
}));

import {
  getActiveStageAbortController,
  setActiveStageAbortController,
  abortAllActiveStages,
} from "../stageAbort.js";

describe("stageAbort", () => {
  it("returns null when no controller is set", () => {
    setActiveStageAbortController("test-task", null);
    expect(getActiveStageAbortController("test-task")).toBeNull();
  });

  it("stores and retrieves an AbortController by taskId", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(getActiveStageAbortController("task-1")).toBe(abort);
    expect(getActiveStageAbortController("task-2")).toBeNull();
    setActiveStageAbortController("task-1", null);
  });

  it("supports multiple concurrent controllers", () => {
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);
    expect(getActiveStageAbortController("task-1")).toBe(abort1);
    expect(getActiveStageAbortController("task-2")).toBe(abort2);
    setActiveStageAbortController("task-1", null);
    setActiveStageAbortController("task-2", null);
  });

  it("returns single controller when no taskId given (backward compat)", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(getActiveStageAbortController()).toBe(abort);
    setActiveStageAbortController("task-1", null);
  });

  it("returns null when multiple controllers active and no taskId given", () => {
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);
    expect(getActiveStageAbortController()).toBeNull();
    setActiveStageAbortController("task-1", null);
    setActiveStageAbortController("task-2", null);
  });

  it("can abort the stored controller", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(abort.signal.aborted).toBe(false);

    abort.abort();
    expect(abort.signal.aborted).toBe(true);
    setActiveStageAbortController("task-1", null);
  });

  it("abortAllActiveStages aborts all controllers and releases locks", () => {
    mockReleaseTaskClaim.mockClear();
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);

    abortAllActiveStages();

    expect(abort1.signal.aborted).toBe(true);
    expect(abort2.signal.aborted).toBe(true);
    expect(getActiveStageAbortController("task-1")).toBeNull();
    expect(getActiveStageAbortController("task-2")).toBeNull();
    // Locks released for each active task
    expect(mockReleaseTaskClaim).toHaveBeenCalledWith("task-1", undefined, undefined);
    expect(mockReleaseTaskClaim).toHaveBeenCalledWith("task-2", undefined, undefined);
    expect(mockReleaseTaskClaim).toHaveBeenCalledTimes(2);
  });
  it("does not let an old attempt clear or abort a newer controller", () => {
    const old = new AbortController();
    const current = new AbortController();
    attemptContext.current = { attemptId: "old" };
    setActiveStageAbortController("task", old);
    attemptContext.current = { attemptId: "new" };
    setActiveStageAbortController("task", current);
    expect(old.signal.aborted).toBe(true);
    attemptContext.current = { attemptId: "old" };
    expect(getActiveStageAbortController("task")).toBeNull();
    setActiveStageAbortController("task", null);
    attemptContext.current = { attemptId: "new" };
    expect(getActiveStageAbortController("task")).toBe(current);
    expect(current.signal.aborted).toBe(false);
    setActiveStageAbortController("task", null);
    attemptContext.current = undefined;
  });
});
