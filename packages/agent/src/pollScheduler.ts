const MIN_POLL_INTERVAL_MS = 10_000;

export interface PollScheduler {
  intervalMs: number;
  stop(): void;
}

export interface PollSchedulerOptions {
  /**
   * Whether a tick waits for the callback promise before the next tick may run.
   *
   * Default `true` — the tick skips while the previous callback is still
   * running, which is what a caller wants when the returned promise represents
   * the work of that single tick.
   *
   * Set to `false` when the promise outlives the tick. The coordinator's poll
   * cycle settles only after every stage it started has finished, and an
   * implementer stage legitimately runs for hours; awaiting it here would hold
   * the re-entrancy guard for that whole time and silently drop every interval
   * tick in between. Ticks are then dispatch-only: the callback is fired and the
   * returned promise is dropped, so no per-tick wrapper stays attached to a
   * multi-hour promise. A callback that opts out therefore owns both its own
   * concurrency control (`pollAndProcess` gates on free stage slots and a cycle
   * ceiling) and its own error handling — the scheduler cannot observe a
   * rejection it no longer holds.
   */
  awaitCallback?: boolean;
}

export function normalizePollIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return MIN_POLL_INTERVAL_MS;
  }

  return Math.max(Math.floor(intervalMs), MIN_POLL_INTERVAL_MS);
}

export function startPollScheduler(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: PollSchedulerOptions = {},
): PollScheduler {
  const normalizedIntervalMs = normalizePollIntervalMs(intervalMs);
  const awaitCallback = options.awaitCallback ?? true;
  let isRunning = false;

  async function runGuardedTick(): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    try {
      await callback();
    } finally {
      isRunning = false;
    }
  }

  const handle = setInterval(() => {
    if (!awaitCallback) {
      void callback();
      return;
    }

    void runGuardedTick();
  }, normalizedIntervalMs);

  return {
    intervalMs: normalizedIntervalMs,
    stop() {
      clearInterval(handle);
    },
  };
}
