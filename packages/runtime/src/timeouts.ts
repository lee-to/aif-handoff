import type { ChildProcess } from "node:child_process";
import { RuntimeExecutionError } from "./errors.js";

/* ------------------------------------------------------------------ */
/*  Shared types                                                      */
/* ------------------------------------------------------------------ */

/** Subset of RuntimeExecutionIntent relevant for timeout logic. */
export interface TimeoutIntent {
  /** Timeout waiting for the first output (ms). Ignored when ≤ 0 or undefined. */
  startTimeoutMs?: number;
  /** Delay before one automatic retry after a start timeout (ms). */
  startRetryDelayMs?: number;
  /** Hard timeout for the entire run (ms). Ignored when ≤ 0 or undefined. */
  runTimeoutMs?: number;
}

export interface TimeoutLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Marker property on timeout errors indicating a single retry is allowed. */
export const TIMEOUT_RETRIABLE_KEY = "__timeoutRetriable__" as const;

/* ------------------------------------------------------------------ */
/*  Error helpers                                                     */
/* ------------------------------------------------------------------ */

function makeStartTimeoutError(ms: number): RuntimeExecutionError {
  const err = new RuntimeExecutionError(
    `Start timeout: runtime produced no output within ${ms}ms`,
    undefined,
    "timeout",
  );
  (err as unknown as Record<string, unknown>)[TIMEOUT_RETRIABLE_KEY] = true;
  return err;
}

function makeRunTimeoutError(ms: number): RuntimeExecutionError {
  return new RuntimeExecutionError(
    `Run timeout: execution exceeded ${ms}ms limit`,
    undefined,
    "timeout",
  );
}

/** Check whether a timeout error signals that a single retry is allowed. */
export function isRetriableTimeoutError(error: unknown): boolean {
  return (
    error instanceof RuntimeExecutionError &&
    error.category === "timeout" &&
    (error as unknown as Record<string, unknown>)[TIMEOUT_RETRIABLE_KEY] === true
  );
}

/** Resolve startRetryDelayMs from intent (defaults to 1 000 ms). */
export function resolveRetryDelay(intent: TimeoutIntent): number {
  const delay = intent.startRetryDelayMs;
  return typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : 1_000;
}

/** Promise-based sleep. Resolves immediately when ms ≤ 0. */
export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Shared validation helpers                                         */
/* ------------------------------------------------------------------ */

function positiveMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/* ------------------------------------------------------------------ */
/*  1. Stream timeout wrapper                                         */
/* ------------------------------------------------------------------ */

/**
 * Wrap an async iterator with start-timeout and run-timeout guards.
 *
 * - **startTimeoutMs**: rejects with a retriable timeout error if the
 *   first `next()` call does not resolve within the given window.
 * - **runTimeoutMs**: fires an AbortController after the overall deadline,
 *   causing any pending `next()` to reject.
 *
 * When a timeout fires the wrapper attempts `iterator.return()` to clean
 * up the underlying stream resource.
 *
 * @returns A new async iterable iterator that transparently forwards
 *          values from the source with timeout enforcement.
 */
export function withStreamTimeouts<T>(
  iterator: AsyncIterableIterator<T>,
  intent: TimeoutIntent,
  abort?: AbortController,
  logger?: TimeoutLogger,
): AsyncIterableIterator<T> {
  const startMs = positiveMs(intent.startTimeoutMs);
  const runMs = positiveMs(intent.runTimeoutMs);

  // Nothing to wrap — return source iterator as-is
  if (startMs === null && runMs === null) return iterator;

  let firstYielded = false;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  // Run timeout — abort the whole stream after deadline
  if (runMs !== null) {
    runTimer = setTimeout(() => {
      logger?.warn?.({ runTimeoutMs: runMs }, "Stream run timeout reached, aborting");
      abort?.abort();
      cleanup();
    }, runMs);
  }

  function cleanup(): void {
    if (startTimer !== null) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    if (runTimer !== null) {
      clearTimeout(runTimer);
      runTimer = null;
    }
    done = true;
  }

  async function cleanupIterator(): Promise<void> {
    try {
      await iterator.return?.();
    } catch {
      // best-effort stream cleanup
    }
  }

  async function next(): Promise<IteratorResult<T>> {
    if (done) return { value: undefined as unknown as T, done: true };

    // Apply start timeout only on the first call
    if (!firstYielded && startMs !== null) {
      const result = await Promise.race<IteratorResult<T> | "START_TIMEOUT">([
        iterator.next(),
        new Promise<"START_TIMEOUT">((resolve) => {
          startTimer = setTimeout(() => {
            logger?.warn?.(
              { startTimeoutMs: startMs },
              "Stream start timeout reached, no output received",
            );
            resolve("START_TIMEOUT");
          }, startMs);
        }),
      ]);

      if (result === "START_TIMEOUT") {
        cleanup();
        await cleanupIterator();
        throw makeStartTimeoutError(startMs);
      }

      // Clear start timer — first value received
      if (startTimer !== null) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      firstYielded = true;

      if (result.done) {
        cleanup();
      }
      return result;
    }

    // Subsequent calls — no start timeout, but run timeout still active via abort
    try {
      const result = await iterator.next();
      if (!firstYielded) firstYielded = true;
      if (result.done) {
        cleanup();
      }
      return result;
    } catch (error) {
      cleanup();
      // If the abort was triggered by run timeout, throw a clear error
      if (abort?.signal.aborted && runMs !== null) {
        await cleanupIterator();
        throw makeRunTimeoutError(runMs);
      }
      throw error;
    }
  }

  const wrapped: AsyncIterableIterator<T> = {
    next,
    async return() {
      cleanup();
      await cleanupIterator();
      return { value: undefined as unknown as T, done: true };
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };

  return wrapped;
}

/* ------------------------------------------------------------------ */
/*  2. Process timeout wrapper                                        */
/* ------------------------------------------------------------------ */

export interface ProcessTimeoutResult {
  /**
   * Call to remove all timers. Must be called on normal process exit
   * or when the caller no longer needs timeout tracking.
   */
  cleanup: () => void;

  /**
   * Resolves to `true` if the process was killed due to a start timeout.
   * Resolves to `false` if the process emitted output before the start window.
   * The caller checks this after the process closes to decide whether to retry.
   */
  startTimedOut: Promise<boolean>;

  /**
   * Whether the process was killed due to the overall run timeout.
   * Check this after the process 'close' event.
   */
  readonly runTimedOut: boolean;
}

/**
 * Attach start-timeout and run-timeout timers to a child process.
 *
 * - **startTimeoutMs**: kills the process (SIGKILL) if neither stdout nor
 *   stderr emits any data within the window. The `startTimedOut` promise
 *   resolves to `true` so the caller can retry after `startRetryDelayMs`.
 * - **runTimeoutMs**: kills the process (SIGKILL) after the overall deadline.
 *
 * The caller is responsible for checking `startTimedOut` / `runTimedOut`
 * after the process closes and for constructing the appropriate error.
 *
 * @returns A handle with cleanup and timeout-status accessors.
 */
export function withProcessTimeouts(
  child: ChildProcess,
  intent: TimeoutIntent,
  logger?: TimeoutLogger,
): ProcessTimeoutResult {
  const startMs = positiveMs(intent.startTimeoutMs);
  const runMs = positiveMs(intent.runTimeoutMs);

  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let _startTimedOut = false;
  let _runTimedOut = false;
  let startResolved = false;

  let resolveStart!: (value: boolean) => void;
  const startTimedOut = new Promise<boolean>((resolve) => {
    resolveStart = resolve;
  });

  function clearStartTimer(): void {
    if (startTimer !== null) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    if (!startResolved) {
      startResolved = true;
      resolveStart(false);
    }
  }

  function cleanup(): void {
    clearStartTimer();
    if (runTimer !== null) {
      clearTimeout(runTimer);
      runTimer = null;
    }
  }

  // Monitor stdout/stderr to detect first output
  const onData = (): void => {
    clearStartTimer();
  };

  if (startMs !== null) {
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    startTimer = setTimeout(() => {
      startTimer = null;
      _startTimedOut = true;
      startResolved = true;
      resolveStart(true);
      logger?.warn?.(
        { startTimeoutMs: startMs, pid: child.pid },
        "Process start timeout reached, killing process",
      );
      child.kill("SIGKILL");
    }, startMs);
  } else {
    // No start timeout — resolve immediately
    startResolved = true;
    resolveStart(false);
  }

  if (runMs !== null) {
    runTimer = setTimeout(() => {
      runTimer = null;
      _runTimedOut = true;
      logger?.warn?.(
        { runTimeoutMs: runMs, pid: child.pid },
        "Process run timeout reached, killing process",
      );
      child.kill("SIGKILL");
    }, runMs);
  }

  return {
    cleanup,
    startTimedOut,
    get runTimedOut() {
      return _runTimedOut;
    },
  };
}

/** Create a RuntimeExecutionError for a process start timeout. */
export function makeProcessStartTimeoutError(ms: number): RuntimeExecutionError {
  return makeStartTimeoutError(ms);
}

/** Create a RuntimeExecutionError for a process run timeout. */
export function makeProcessRunTimeoutError(ms: number): RuntimeExecutionError {
  return makeRunTimeoutError(ms);
}
