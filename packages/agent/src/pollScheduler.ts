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
   * tick in between. A callback that opts out must own its own concurrency
   * control (`pollAndProcess` gates on free stage slots and a cycle ceiling).
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

  async function runTick(): Promise<void> {
    if (!awaitCallback) {
      await callback();
      return;
    }

    if (isRunning) return;
    isRunning = true;
    try {
      await callback();
    } finally {
      isRunning = false;
    }
  }

  const handle = setInterval(() => {
    void runTick();
  }, normalizedIntervalMs);

  return {
    intervalMs: normalizedIntervalMs,
    stop() {
      clearInterval(handle);
    },
  };
}
