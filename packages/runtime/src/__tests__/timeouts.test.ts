import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  isRetriableTimeoutError,
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
  withStreamTimeouts,
} from "../timeouts.js";
import { RuntimeExecutionError } from "../errors.js";

/* ------------------------------------------------------------------ */
/*  Test helpers                                                      */
/* ------------------------------------------------------------------ */

/** Create a controllable async iterator for testing. */
function createMockIterator<T>(): {
  iterator: AsyncIterableIterator<T>;
  push: (value: T) => void;
  end: () => void;
  error: (err: Error) => void;
} {
  const queue: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  }> = [];
  const buffer: T[] = [];
  let done = false;
  let pendingError: Error | null = null;

  const iterator: AsyncIterableIterator<T> = {
    next() {
      if (pendingError) {
        const err = pendingError;
        pendingError = null;
        return Promise.reject(err);
      }
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift()!, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
      return new Promise<IteratorResult<T>>((resolve, reject) => {
        queue.push({ resolve, reject });
      });
    },
    return() {
      done = true;
      for (const pending of queue) {
        pending.resolve({ value: undefined as unknown as T, done: true });
      }
      queue.length = 0;
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return {
    iterator,
    push(value: T) {
      if (queue.length > 0) {
        queue.shift()!.resolve({ value, done: false });
      } else {
        buffer.push(value);
      }
    },
    end() {
      done = true;
      for (const pending of queue) {
        pending.resolve({ value: undefined as unknown as T, done: true });
      }
      queue.length = 0;
    },
    error(err: Error) {
      if (queue.length > 0) {
        queue.shift()!.reject(err);
      } else {
        pendingError = err;
      }
    },
  };
}

/** Create a minimal mock ChildProcess for testing. */
function createMockChild(): ChildProcess & {
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitClose: (code: number) => void;
} {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const processEmitter = new EventEmitter();

  const child = processEmitter as unknown as ChildProcess & {
    emitStdout: (data: string) => void;
    emitStderr: (data: string) => void;
    emitClose: (code: number) => void;
  };

  child.stdout = stdoutEmitter as ChildProcess["stdout"];
  child.stderr = stderrEmitter as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 12345, writable: true });
  child.kill = vi.fn().mockReturnValue(true);

  child.emitStdout = (data: string) => stdoutEmitter.emit("data", Buffer.from(data));
  child.emitStderr = (data: string) => stderrEmitter.emit("data", Buffer.from(data));
  child.emitClose = (code: number) => processEmitter.emit("close", code);

  return child;
}

/* ------------------------------------------------------------------ */
/*  withStreamTimeouts                                                */
/* ------------------------------------------------------------------ */

describe("withStreamTimeouts", () => {
  it("passes through values when no timeouts are set", async () => {
    const mock = createMockIterator<string>();
    mock.push("a");
    mock.push("b");
    mock.end();

    const wrapped = withStreamTimeouts(mock.iterator, {});
    const results: string[] = [];
    for await (const value of wrapped) {
      results.push(value);
    }
    expect(results).toEqual(["a", "b"]);
  });

  it("passes through values when output arrives before start timeout", async () => {
    const mock = createMockIterator<string>();
    const wrapped = withStreamTimeouts(mock.iterator, { startTimeoutMs: 500 });

    // Push value immediately — before timeout
    mock.push("first");
    mock.end();

    const results: string[] = [];
    for await (const value of wrapped) {
      results.push(value);
    }
    expect(results).toEqual(["first"]);
  });

  it("throws retriable timeout error when start timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockIterator<string>();
      const wrapped = withStreamTimeouts(mock.iterator, { startTimeoutMs: 100 });

      const nextPromise = wrapped.next();
      vi.advanceTimersByTime(100);

      await expect(nextPromise).rejects.toThrow("Start timeout");
      await expect(nextPromise).rejects.toSatisfy(isRetriableTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws run timeout error when run timeout expires and abort is triggered", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockIterator<string>();
      const abort = new AbortController();
      const wrapped = withStreamTimeouts(mock.iterator, { runTimeoutMs: 200 }, abort);

      // First value arrives OK
      mock.push("first");
      const first = await wrapped.next();
      expect(first.value).toBe("first");

      // Now the run timeout fires while waiting for the next value
      const nextPromise = wrapped.next();
      vi.advanceTimersByTime(200);

      // The abort should signal — mock iterator needs to reject on abort
      mock.error(new Error("aborted"));

      await expect(nextPromise).rejects.toThrow("Run timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timers on return()", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockIterator<string>();
      const wrapped = withStreamTimeouts(mock.iterator, {
        startTimeoutMs: 100,
        runTimeoutMs: 500,
      });

      // Calling return before any next() should clean up
      await wrapped.return!();

      // Advancing timers should not cause issues
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns iterator as-is when no timeouts configured", () => {
    const mock = createMockIterator<string>();
    const wrapped = withStreamTimeouts(mock.iterator, {});
    expect(wrapped).toBe(mock.iterator);
  });

  it("returns iterator as-is when timeouts are zero or negative", () => {
    const mock = createMockIterator<string>();
    expect(withStreamTimeouts(mock.iterator, { startTimeoutMs: 0 })).toBe(mock.iterator);
    expect(withStreamTimeouts(mock.iterator, { startTimeoutMs: -1 })).toBe(mock.iterator);
    expect(withStreamTimeouts(mock.iterator, { runTimeoutMs: 0 })).toBe(mock.iterator);
  });
});

/* ------------------------------------------------------------------ */
/*  withProcessTimeouts                                               */
/* ------------------------------------------------------------------ */

describe("withProcessTimeouts", () => {
  it("does not kill process when output arrives before start timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const result = withProcessTimeouts(child, { startTimeoutMs: 200 });

      // Output arrives at 50ms
      vi.advanceTimersByTime(50);
      child.emitStdout("hello");

      vi.advanceTimersByTime(200);
      const timedOut = await result.startTimedOut;
      expect(timedOut).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
      result.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills process on start timeout and signals retriable", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const result = withProcessTimeouts(child, { startTimeoutMs: 100 });

      vi.advanceTimersByTime(100);

      const timedOut = await result.startTimedOut;
      expect(timedOut).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      result.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills process on run timeout", () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const result = withProcessTimeouts(child, { runTimeoutMs: 300 });

      // Output arrives, so no start timeout
      child.emitStdout("ok");

      vi.advanceTimersByTime(300);
      expect(result.runTimedOut).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      result.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not kill when cleanup is called before timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const result = withProcessTimeouts(child, {
        startTimeoutMs: 100,
        runTimeoutMs: 300,
      });

      result.cleanup();
      vi.advanceTimersByTime(400);

      expect(child.kill).not.toHaveBeenCalled();
      const timedOut = await result.startTimedOut;
      expect(timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears start timer on stderr output too", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      const result = withProcessTimeouts(child, { startTimeoutMs: 200 });

      vi.advanceTimersByTime(50);
      child.emitStderr("some warning");

      vi.advanceTimersByTime(200);
      const timedOut = await result.startTimedOut;
      expect(timedOut).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
      result.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves startTimedOut to false when no start timeout configured", async () => {
    const child = createMockChild();
    const result = withProcessTimeouts(child, { runTimeoutMs: 5000 });

    const timedOut = await result.startTimedOut;
    expect(timedOut).toBe(false);
    result.cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  Error helpers                                                     */
/* ------------------------------------------------------------------ */

describe("isRetriableTimeoutError", () => {
  it("returns true for start timeout errors", () => {
    const err = makeProcessStartTimeoutError(100);
    expect(isRetriableTimeoutError(err)).toBe(true);
  });

  it("returns false for run timeout errors", () => {
    const err = makeProcessRunTimeoutError(100);
    expect(isRetriableTimeoutError(err)).toBe(false);
  });

  it("returns false for non-timeout RuntimeExecutionErrors", () => {
    const err = new RuntimeExecutionError("some error", undefined, "auth");
    expect(isRetriableTimeoutError(err)).toBe(false);
  });

  it("returns false for plain errors", () => {
    expect(isRetriableTimeoutError(new Error("timeout"))).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isRetriableTimeoutError(null)).toBe(false);
    expect(isRetriableTimeoutError("timeout")).toBe(false);
  });
});

describe("resolveRetryDelay", () => {
  it("returns configured delay", () => {
    expect(resolveRetryDelay({ startRetryDelayMs: 2000 })).toBe(2000);
  });

  it("defaults to 1000ms", () => {
    expect(resolveRetryDelay({})).toBe(1000);
  });

  it("returns 0 for zero delay", () => {
    expect(resolveRetryDelay({ startRetryDelayMs: 0 })).toBe(0);
  });

  it("defaults for negative values", () => {
    expect(resolveRetryDelay({ startRetryDelayMs: -1 })).toBe(1000);
  });
});

describe("sleepMs", () => {
  it("resolves immediately for zero", async () => {
    const start = Date.now();
    await sleepMs(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves immediately for negative", async () => {
    const start = Date.now();
    await sleepMs(-100);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
