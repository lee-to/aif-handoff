import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";

const { loggerMock, testDb } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  testDb: {
    current: undefined as unknown,
  },
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    logger: () => loggerMock,
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  findPreferredCodexLimitHeadForOverlay,
  listCodexLimitHeadsForOverlay,
  upsertCodexLimitHeads,
} = await import("../index.js");

function makeCodexSnapshot(checkedAt = "2026-04-23T10:00:00.000Z") {
  return {
    source: "sdk_event" as const,
    status: "warning" as const,
    precision: "heuristic" as const,
    checkedAt,
    providerId: "openai",
    runtimeId: "codex",
    profileId: "profile-codex",
    primaryScope: "time" as const,
    windows: [
      {
        scope: "time" as const,
        percentUsed: 61,
        percentRemaining: 39,
      },
    ],
  };
}

describe("Codex index logging", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  it("keeps overlay debug metadata free of account and project scope identifiers", () => {
    upsertCodexLimitHeads([
      {
        accountFingerprint: "acct-sensitive",
        projectRoot: "C:\\Users\\Ichi\\secret-project",
        limitId: "codex",
        snapshot: makeCodexSnapshot(),
        observedAt: "2026-04-23T10:00:00.000Z",
      },
    ]);
    loggerMock.debug.mockClear();

    const rows = listCodexLimitHeadsForOverlay({
      accountFingerprint: "acct-sensitive",
      projectRoot: "C:/Users/Ichi/secret-project",
      includeGlobalFallback: true,
      limitId: "codex",
      limit: 5,
    });
    const preferred = findPreferredCodexLimitHeadForOverlay({
      accountFingerprint: "acct-sensitive",
      projectRoot: "C:/Users/Ichi/secret-project",
      includeGlobalFallback: true,
      limitId: "codex",
    });

    expect(rows).toHaveLength(1);
    expect(preferred).not.toBeNull();
    const debugCalls = JSON.stringify(loggerMock.debug.mock.calls);
    expect(debugCalls).not.toContain("acct-sensitive");
    expect(debugCalls).not.toContain("c:/users/ichi/secret-project");
    expect(debugCalls).not.toContain("accountFingerprint");
    expect(debugCalls).not.toContain("projectRoot");
    expect(debugCalls).not.toContain("headKey");
  });
});
