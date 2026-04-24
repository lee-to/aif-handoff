import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiCompatibleLimitSnapshot } from "../openaiRateLimits.js";
import { RuntimeLimitScope, RuntimeLimitStatus } from "../types.js";

function createHeaders(entries: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(entries)) {
    headers.set(key, value);
  }
  return headers;
}

describe("buildOpenAiCompatibleLimitSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when no rate-limit or retry-after metadata is present", () => {
    expect(
      buildOpenAiCompatibleLimitSnapshot(createHeaders({}), {
        providerId: "openai",
        runtimeId: "codex",
      }),
    ).toBeNull();
  });

  it("builds a warning snapshot from exact request/token headers", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-reset-requests": "60",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "900",
        "x-ratelimit-reset-tokens": "120",
      }),
      {
        providerId: "openai",
        runtimeId: "codex",
        profileId: "profile-1",
        checkedAt: "2026-04-17T00:00:00.000Z",
      },
    );

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.WARNING,
      primaryScope: RuntimeLimitScope.REQUESTS,
      retryAfterSeconds: null,
      resetAt: "2026-04-17T00:01:00.000Z",
      warningThreshold: 10,
      profileId: "profile-1",
    });
    expect(snapshot?.windows).toMatchObject([
      {
        scope: RuntimeLimitScope.REQUESTS,
        limit: 100,
        remaining: 5,
        used: 95,
        percentRemaining: 5,
        percentUsed: 95,
        resetAt: "2026-04-17T00:01:00.000Z",
      },
      {
        scope: RuntimeLimitScope.TOKENS,
        limit: 1000,
        remaining: 900,
        used: 100,
        percentRemaining: 90,
        percentUsed: 10,
        resetAt: "2026-04-17T00:02:00.000Z",
      },
    ]);
  });

  it("uses the violated window reset instead of the earliest unrelated reset", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-reset-requests": "60m",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "900",
        "x-ratelimit-reset-tokens": "5m",
      }),
      {
        providerId: "openai",
        runtimeId: "codex",
      },
    );

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.WARNING,
      primaryScope: RuntimeLimitScope.REQUESTS,
      resetAt: "2026-04-17T01:00:00.000Z",
    });
    expect(snapshot?.windows).toMatchObject([
      {
        scope: RuntimeLimitScope.REQUESTS,
        percentRemaining: 5,
        resetAt: "2026-04-17T01:00:00.000Z",
      },
      {
        scope: RuntimeLimitScope.TOKENS,
        percentRemaining: 90,
        resetAt: "2026-04-17T00:05:00.000Z",
      },
    ]);
  });

  it("marks exhausted windows as blocked and chooses the blocking scope", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "50",
        "x-ratelimit-reset-requests": "10m",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "2026-04-17T00:05:00.000Z",
      }),
      {
        providerId: "openrouter",
        runtimeId: "openrouter",
      },
    );

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.BLOCKED,
      primaryScope: RuntimeLimitScope.TOKENS,
      resetAt: "2026-04-17T00:05:00.000Z",
    });
  });

  it("builds retry-after-only snapshots when headers are absent", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(createHeaders({}), {
      providerId: "openai",
      runtimeId: "codex",
      statusOverride: RuntimeLimitStatus.WARNING,
      retryAfterHeader: "2m30s",
    });

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.WARNING,
      primaryScope: null,
      retryAfterSeconds: 150,
      resetAt: "2026-04-17T00:02:30.000Z",
      warningThreshold: null,
      windows: [],
    });
  });

  it("parses HTTP-date retry-after values", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(createHeaders({}), {
      providerId: "openai",
      runtimeId: "codex",
      retryAfterHeader: "2026-04-17T00:10:00.000Z",
    });

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.UNKNOWN,
      retryAfterSeconds: 600,
      resetAt: "2026-04-17T00:10:00.000Z",
    });
  });

  it("drops out-of-range reset hints instead of throwing", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "50",
        "x-ratelimit-reset-requests": String(Number.MAX_SAFE_INTEGER),
      }),
      {
        providerId: "openai",
        runtimeId: "codex",
        retryAfterHeader: String(Number.MAX_SAFE_INTEGER),
      },
    );

    expect(snapshot).toMatchObject({
      status: RuntimeLimitStatus.OK,
      retryAfterSeconds: null,
      resetAt: null,
    });
    expect(snapshot?.windows).toMatchObject([
      {
        scope: RuntimeLimitScope.REQUESTS,
        limit: 100,
        remaining: 50,
        resetAt: null,
      },
    ]);
  });

  it("parses x-ratelimit-reset-* numeric values as epoch seconds when applicable", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "10",
        "x-ratelimit-reset-requests": "1776389400",
      }),
      {
        providerId: "openai",
        runtimeId: "codex",
      },
    );

    expect(snapshot?.resetAt).toBe("2026-04-17T01:30:00.000Z");
    expect(snapshot?.windows[0]?.resetAt).toBe("2026-04-17T01:30:00.000Z");
  });

  it("parses x-ratelimit-reset-* numeric values as epoch milliseconds when applicable", () => {
    const snapshot = buildOpenAiCompatibleLimitSnapshot(
      createHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "10",
        "x-ratelimit-reset-requests": "1776389400000",
      }),
      {
        providerId: "openai",
        runtimeId: "codex",
      },
    );

    expect(snapshot?.resetAt).toBe("2026-04-17T01:30:00.000Z");
    expect(snapshot?.windows[0]?.resetAt).toBe("2026-04-17T01:30:00.000Z");
  });
});
