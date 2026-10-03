import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tasks, projects, getEnv } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { eq } from "drizzle-orm";
import { claimCoordinatorTaskIfEligible, releaseStaleTaskClaims } from "@aif/data";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => Object.assign(actual.getEnv(), { AIF_AGENT_ATTEMPT_RECOVERY_ENABLED: true }),
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../notifier.js", () => ({
  notifyTaskBroadcast: vi.fn().mockResolvedValue(undefined),
}));

import {
  parseUpdatedAtMs,
  releaseDueBlockedTasks,
  recoverStaleInProgressTasks,
  getRandomBackoffMinutes,
} from "../taskWatchdog.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROJECT_ID = "proj-watchdog-test";

function insertProject(db: ReturnType<typeof createTestDb>) {
  const existing = db.select().from(projects).where(eq(projects.id, PROJECT_ID)).get();
  if (!existing) {
    db.insert(projects)
      .values({
        id: PROJECT_ID,
        name: "Watchdog Test Project",
        rootPath: "/tmp/watchdog-test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

function insertTask(db: ReturnType<typeof createTestDb>, overrides: Record<string, unknown>) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(tasks)
    .values({
      id,
      projectId: PROJECT_ID,
      title: "Watchdog test task",
      description: "",
      status: "backlog",
      position: 1000,
      autoMode: true,
      isFix: false,
      paused: false,
      reworkRequested: false,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .run();
  return id;
}

describe("parseUpdatedAtMs", () => {
  it("parses ISO 8601 with Z suffix", () => {
    const ms = parseUpdatedAtMs("2026-01-15T10:30:00Z");
    expect(ms).toBe(Date.parse("2026-01-15T10:30:00Z"));
  });

  it("parses ISO 8601 with timezone offset", () => {
    const ms = parseUpdatedAtMs("2026-01-15T10:30:00+03:00");
    expect(ms).toBe(Date.parse("2026-01-15T10:30:00+03:00"));
  });

  it("normalizes space-separated format without timezone", () => {
    const ms = parseUpdatedAtMs("2026-01-15 10:30:00");
    expect(ms).toBe(Date.parse("2026-01-15T10:30:00Z"));
  });

  it("returns null for invalid date", () => {
    expect(parseUpdatedAtMs("not-a-date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseUpdatedAtMs("")).toBeNull();
  });
});

describe("getRandomBackoffMinutes", () => {
  it("returns a number between 5 and 15", () => {
    for (let i = 0; i < 50; i++) {
      const mins = getRandomBackoffMinutes();
      expect(mins).toBeGreaterThanOrEqual(5);
      expect(mins).toBeLessThanOrEqual(15);
    }
  });
});

describe("releaseDueBlockedTasks", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    insertProject(testDb.current);
  });

  it("releases blocked task when retryAfter has passed", () => {
    const db = testDb.current;
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const id = insertTask(db, {
      status: "blocked_external",
      blockedFromStatus: "planning",
      retryAfter: pastTime,
      retryCount: 1,
      runtimeLimitSnapshotJson: JSON.stringify({
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "profile-1",
        windows: [{ scope: "time" }],
      }),
    });

    releaseDueBlockedTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("planning");
    expect(task?.blockedReason).toBeNull();
    expect(task?.retryCount).toBe(1);
    expect(task?.runtimeLimitSnapshotJson).toBeNull();
  });

  it("does not release blocked task when retryAfter is in the future", () => {
    const db = testDb.current;
    const futureTime = new Date(Date.now() + 600_000).toISOString();
    const id = insertTask(db, {
      status: "blocked_external",
      blockedFromStatus: "planning",
      retryAfter: futureTime,
      retryCount: 1,
    });

    releaseDueBlockedTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("blocked_external");
  });

  it("does not release task without blockedFromStatus", () => {
    const db = testDb.current;
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const id = insertTask(db, {
      status: "blocked_external",
      blockedFromStatus: null,
      retryAfter: pastTime,
    });

    releaseDueBlockedTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("blocked_external");
  });
});

describe("recoverStaleInProgressTasks", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    insertProject(testDb.current);
  });

  it("blocks stale planning task with auto-recover", () => {
    const db = testDb.current;
    const staleTime = new Date(Date.now() - 100 * 60_000).toISOString();
    const id = insertTask(db, {
      status: "planning",
      lastHeartbeatAt: staleTime,
      stageStartedAt: staleTime,
      updatedAt: staleTime,
      retryCount: 0,
    });

    recoverStaleInProgressTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("blocked_external");
    expect(task?.blockedFromStatus).toBe("planning");
    expect(task?.retryCount).toBe(1);
    expect(task?.retryAfter).toBeTruthy();
  });

  it("quarantines task after max retries", () => {
    const db = testDb.current;
    const staleTime = new Date(Date.now() - 100 * 60_000).toISOString();
    const id = insertTask(db, {
      status: "implementing",
      lastHeartbeatAt: staleTime,
      stageStartedAt: staleTime,
      updatedAt: staleTime,
      retryCount: 99,
    });

    recoverStaleInProgressTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("blocked_external");
    expect(task?.blockedFromStatus).toBe("implementing");
    expect(task?.retryAfter).toBeNull();
    expect(task?.blockedReason).toContain("auto-retry limit reached");
  });

  it("does not touch fresh in-progress tasks", () => {
    const db = testDb.current;
    const freshTime = new Date().toISOString();
    const id = insertTask(db, {
      status: "planning",
      lastHeartbeatAt: freshTime,
      updatedAt: freshTime,
    });

    recoverStaleInProgressTasks();

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(task?.status).toBe("planning");
  });

  it("does not recover a task that only waited for capacity and never started", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const id = insertTask(testDb.current, { status: "review" });
    vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);

    recoverStaleInProgressTasks();

    expect(testDb.current.select().from(tasks).where(eq(tasks.id, id)).get()).toMatchObject({
      status: "review",
      retryCount: 0,
      retryAfter: null,
    });
  });

  it("exhausts the retry budget across complete stale/backoff/retry cycles", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = testDb.current;
    const id = insertTask(db, { status: "planning" });
    const maxRetries = getEnv().AGENT_STAGE_STALE_MAX_RETRY;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      expect(
        claimCoordinatorTaskIfEligible({
          taskId: id,
          expectedProjectId: PROJECT_ID,
          expectedStatus: "planning",
          coordinatorId: "fake-runtime",
          lockDurationMs: 60_000,
        }),
      ).toBeDefined();
      vi.setSystemTime(Date.now() + getEnv().AGENT_STAGE_STALE_TIMEOUT_MS + 1);
      releaseStaleTaskClaims();
      recoverStaleInProgressTasks();
      const blocked = db.select().from(tasks).where(eq(tasks.id, id)).get()!;
      expect(blocked.status).toBe("blocked_external");
      if (attempt === maxRetries) {
        expect(blocked.retryAfter).toBeNull();
        expect(blocked.retryCount).toBe(maxRetries);
        vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
        releaseDueBlockedTasks();
        expect(db.select().from(tasks).where(eq(tasks.id, id)).get()!.status).toBe(
          "blocked_external",
        );
      } else {
        expect(blocked.retryCount).toBe(attempt + 1);
        expect(Date.parse(blocked.retryAfter!)).toBe(Date.now() + 10 * 60_000);
        vi.setSystemTime(new Date(blocked.retryAfter!));
        releaseDueBlockedTasks();
        expect(db.select().from(tasks).where(eq(tasks.id, id)).get()!.retryCount).toBe(attempt + 1);
      }
    }
  });
});
