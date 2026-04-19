import { describe, expect, it } from "vitest";
import type { RuntimeLimitSnapshot } from "@aif/shared/browser";
import { getRuntimeLimitDisplay } from "./runtimeLimits";

function createSnapshot(overrides: Partial<RuntimeLimitSnapshot> = {}): RuntimeLimitSnapshot {
  return {
    source: "api_headers",
    status: "blocked",
    precision: "exact",
    checkedAt: "2026-04-17T00:00:00.000Z",
    providerId: "anthropic",
    runtimeId: "claude",
    profileId: "profile-1",
    primaryScope: "requests",
    resetAt: "2026-04-17T01:00:00.000Z",
    warningThreshold: 10,
    windows: [
      {
        scope: "requests",
        percentRemaining: 5,
        warningThreshold: 10,
        resetAt: "2026-04-17T01:00:00.000Z",
      },
    ],
    providerMeta: null,
    ...overrides,
  };
}

describe("getRuntimeLimitDisplay", () => {
  it("keeps an active blocked snapshot blocked before resetAt", () => {
    const display = getRuntimeLimitDisplay(createSnapshot(), {
      nowMs: Date.parse("2026-04-17T00:30:00.000Z"),
    });

    expect(display).toMatchObject({
      state: "active",
      tone: "error",
      isExpired: false,
      label: "Blocked",
      shortLabel: "BLOCKED",
    });
  });

  it("degrades blocked snapshots to expired once resetAt has passed", () => {
    const display = getRuntimeLimitDisplay(createSnapshot(), {
      nowMs: Date.parse("2026-04-17T01:30:00.000Z"),
    });

    expect(display).toMatchObject({
      state: "expired",
      tone: "info",
      isExpired: true,
      label: "Expired",
      shortLabel: "EXPIRED",
    });
    expect(display?.summary).toContain("reset window has elapsed");
    expect(display?.resetText).toContain("Provider reset window elapsed");
  });

  it("degrades warning snapshots to expired once their reset window has passed", () => {
    const display = getRuntimeLimitDisplay(
      createSnapshot({
        status: "warning",
      }),
      {
        nowMs: Date.parse("2026-04-17T01:30:00.000Z"),
      },
    );

    expect(display).toMatchObject({
      state: "expired",
      tone: "info",
      isExpired: true,
      label: "Expired",
      shortLabel: "EXPIRED",
    });
  });

  it("shows signal_no_reset when provider signal has no future reset hint", () => {
    const display = getRuntimeLimitDisplay(
      createSnapshot({
        resetAt: null,
        windows: [{ scope: "requests", percentRemaining: 5, warningThreshold: 10, resetAt: null }],
      }),
      {
        nowMs: Date.parse("2026-04-17T00:30:00.000Z"),
      },
    );

    expect(display).toMatchObject({
      state: "signal_no_reset",
      tone: "info",
      isExpired: false,
      label: "Signal Without Reset",
      shortLabel: "NO RESET",
    });
    expect(display?.summary).toContain("without a future reset hint");
    expect(display?.resetText).toBeNull();
  });

  it("does not treat task retry schedule as provider reset signal", () => {
    const display = getRuntimeLimitDisplay(
      createSnapshot({
        resetAt: null,
        windows: [{ scope: "requests", percentRemaining: 5, warningThreshold: 10, resetAt: null }],
      }),
      {
        nowMs: Date.parse("2026-04-17T00:30:00.000Z"),
        taskRetryAfter: "2026-04-17T01:00:00.000Z",
      },
    );

    expect(display).toMatchObject({
      state: "signal_no_reset",
      taskRetryAt: "2026-04-17T01:00:00.000Z",
    });
    expect(display?.taskRetryText).toContain("Task retry is scheduled");
  });

  it("degrades old ok snapshots to historical state", () => {
    const display = getRuntimeLimitDisplay(
      createSnapshot({
        status: "ok",
        checkedAt: "2026-04-16T20:00:00.000Z",
      }),
      {
        nowMs: Date.parse("2026-04-17T00:30:00.000Z"),
      },
    );

    expect(display).toMatchObject({
      state: "historical",
      tone: "info",
      label: "Last Known Healthy",
      shortLabel: "LAST KNOWN",
    });
  });
});
