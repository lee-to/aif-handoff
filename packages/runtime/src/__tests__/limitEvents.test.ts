import { describe, expect, it } from "vitest";
import { buildRuntimeLimitEvent } from "../limitEvents.js";
import {
  RUNTIME_LIMIT_EVENT_TYPE,
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
} from "../types.js";

function createSnapshot(status: RuntimeLimitStatus): RuntimeLimitSnapshot {
  return {
    source: RuntimeLimitSource.API_HEADERS,
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: "2026-04-17T00:00:00.000Z",
    providerId: "openai",
    runtimeId: "codex",
    profileId: "profile-1",
    primaryScope: RuntimeLimitScope.REQUESTS,
    resetAt: "2026-04-17T00:05:00.000Z",
    retryAfterSeconds: 300,
    warningThreshold: 10,
    windows: [],
    providerMeta: null,
  };
}

describe("buildRuntimeLimitEvent", () => {
  it("marks blocked snapshots as warn-level runtime-limit events", () => {
    const snapshot = createSnapshot(RuntimeLimitStatus.BLOCKED);

    expect(buildRuntimeLimitEvent(snapshot, "rate_limit_event")).toEqual({
      type: RUNTIME_LIMIT_EVENT_TYPE,
      timestamp: snapshot.checkedAt,
      level: "warn",
      message: "Runtime limit state changed: blocked",
      data: {
        snapshot,
        rawType: "rate_limit_event",
      },
    });
  });

  it("marks warning snapshots as info-level events", () => {
    const snapshot = createSnapshot(RuntimeLimitStatus.WARNING);

    expect(buildRuntimeLimitEvent(snapshot)).toEqual({
      type: RUNTIME_LIMIT_EVENT_TYPE,
      timestamp: snapshot.checkedAt,
      level: "info",
      message: "Runtime limit state changed: warning",
      data: {
        snapshot,
      },
    });
  });

  it("marks ok snapshots as debug-level events", () => {
    const snapshot = createSnapshot(RuntimeLimitStatus.OK);

    expect(buildRuntimeLimitEvent(snapshot)).toEqual({
      type: RUNTIME_LIMIT_EVENT_TYPE,
      timestamp: snapshot.checkedAt,
      level: "debug",
      message: "Runtime limit state changed: ok",
      data: {
        snapshot,
      },
    });
  });

  it("falls back to a generic message for unknown statuses", () => {
    const snapshot = createSnapshot(RuntimeLimitStatus.UNKNOWN);

    expect(buildRuntimeLimitEvent(snapshot)).toEqual({
      type: RUNTIME_LIMIT_EVENT_TYPE,
      timestamp: snapshot.checkedAt,
      level: "debug",
      message: "Runtime limit state updated",
      data: {
        snapshot,
      },
    });
  });
});
