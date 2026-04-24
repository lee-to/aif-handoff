import { describe, expect, it, vi } from "vitest";
import { RuntimeExecutionError } from "../errors.js";
import {
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  observeRuntimeLimitEvent,
} from "../limitState.js";
import type { RuntimeLimitSnapshot } from "../types.js";

function createSnapshot(overrides: Partial<RuntimeLimitSnapshot> = {}): RuntimeLimitSnapshot {
  return {
    source: "sdk_event",
    status: "warning",
    precision: "heuristic",
    checkedAt: "2026-04-21T10:00:00.000Z",
    providerId: "anthropic",
    runtimeId: "claude",
    profileId: "profile-1",
    primaryScope: "time",
    resetAt: "2026-04-21T11:00:00.000Z",
    retryAfterSeconds: null,
    warningThreshold: null,
    windows: [],
    providerMeta: null,
    ...overrides,
  };
}

describe("limitState", () => {
  it("observes runtime limit events through the shared helper", () => {
    const debug = vi.fn();
    const snapshot = createSnapshot();

    const observed = observeRuntimeLimitEvent(
      {
        type: "runtime:limit",
        timestamp: snapshot.checkedAt,
        data: { snapshot },
      },
      null,
      {
        logger: { debug },
        observedMessage: "Observed runtime limit event during test execution",
        logContext: { taskId: "task-1" },
      },
    );

    expect(observed).toEqual(snapshot);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runtimeId: "claude",
        providerId: "anthropic",
        status: "warning",
      }),
      "Observed runtime limit event during test execution",
    );
  });

  it("warns and skips malformed runtime limit events", () => {
    const warn = vi.fn();

    const observed = extractLatestRuntimeLimitSnapshot(
      [
        {
          type: "runtime:limit",
          timestamp: "2026-04-21T10:00:00.000Z",
          data: { snapshot: "bad-payload" },
        },
      ],
      {
        logger: { warn },
        malformedMessage: "Dropped malformed runtime limit event in test",
        logContext: { projectId: "project-1" },
      },
    );

    expect(observed).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        eventType: "runtime:limit",
      }),
      "Dropped malformed runtime limit event in test",
    );
  });

  it("extracts nested runtime limit snapshots from chained runtime errors", () => {
    const snapshot = createSnapshot();
    const root = new RuntimeExecutionError("rate limited", undefined, "rate_limit", {
      limitSnapshot: snapshot,
    });
    const wrapped = new Error("wrapper", { cause: root });

    expect(extractRuntimeLimitSnapshotFromError(wrapped)).toEqual(snapshot);
  });

  it("builds stable cache signatures and project-scoped broadcast keys", () => {
    const snapshot = createSnapshot();

    expect(buildRuntimeLimitCacheSignature(snapshot, false)).toContain("persist:");
    expect(buildRuntimeLimitCacheSignature(null, true)).toBe("clear");
    expect(
      buildRuntimeLimitBroadcastCacheKey({
        projectId: "project-1",
        taskId: "task-1",
        runtimeProfileId: "profile-1",
      }),
    ).toBe("project-1:profile-1:task-1");
  });
});
