import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePollIntervalMs, startPollScheduler } from "../pollScheduler.js";

describe("pollScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps millisecond intervals above the minimum unchanged", () => {
    expect(normalizePollIntervalMs(600_000)).toBe(600_000);
  });

  it("clamps invalid or too-small intervals to the minimum", () => {
    expect(normalizePollIntervalMs(0)).toBe(10_000);
    expect(normalizePollIntervalMs(-1)).toBe(10_000);
    expect(normalizePollIntervalMs(9_999)).toBe(10_000);
  });

  it("schedules callbacks using the normalized millisecond interval", async () => {
    const callback = vi.fn();
    const scheduler = startPollScheduler(callback, 600_000);

    expect(scheduler.intervalMs).toBe(600_000);

    await vi.advanceTimersByTimeAsync(599_999);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("skips interval ticks while the previous callback is still running", async () => {
    let resolveCallback: (() => void) | null = null;
    const callback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCallback = resolve;
        }),
    );
    const scheduler = startPollScheduler(callback, 10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);

    const finishCallback: () => void =
      resolveCallback ??
      (() => {
        throw new Error("Expected callback resolver to be captured");
      });
    finishCallback();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("keeps ticking while a previous callback is pending when awaitCallback is false", async () => {
    // The coordinator's poll cycle promise settles only after every stage it
    // started has finished (hours for an implementer). The re-entrancy guard
    // must not swallow ticks for that whole time — otherwise WebSocket wake
    // events become the coordinator's only trigger.
    const callback = vi.fn(() => new Promise<void>(() => {}));
    const scheduler = startPollScheduler(callback, 10_000, { awaitCallback: false });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(callback).toHaveBeenCalledTimes(4);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(4);
  });
});
