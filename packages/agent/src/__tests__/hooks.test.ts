import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { tasks, projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return { ...actual, getEnv: vi.fn() };
});

const { getEnv } = await import("@aif/shared");
const mockedGetEnv = vi.mocked(getEnv);

const {
  logActivity,
  flushActivityQueue,
  flushAllActivityQueues,
  disposeActivityQueue,
  sanitizeForActivityLog,
} = await import("../hooks.js");

const PROJECT_ID = "test-project";
const TASK_ID = "test-task-1";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    CODEX_CLI_PATH: undefined,
    AIF_RUNTIME_MODULES: [],
    AIF_DEFAULT_RUNTIME_ID: "claude",
    AIF_DEFAULT_PROVIDER_ID: "anthropic",
    PORT: 3009,
    POLL_INTERVAL_MS: 30000,
    AGENT_STAGE_STALE_TIMEOUT_MS: 5400000,
    AGENT_STAGE_STALE_MAX_RETRY: 3,
    AGENT_STAGE_RUN_TIMEOUT_MS: 3600000,
    AGENT_QUERY_START_TIMEOUT_MS: 60000,
    AGENT_QUERY_START_RETRY_DELAY_MS: 1000,
    API_RUNTIME_START_TIMEOUT_MS: 60000,
    API_RUNTIME_RUN_TIMEOUT_MS: 120000,
    DATABASE_URL: "./data/aif.sqlite",
    CORS_ORIGIN: "*",
    API_BASE_URL: "http://localhost:3009",
    AGENT_QUERY_AUDIT_ENABLED: true,
    LOG_LEVEL: "debug" as const,
    ACTIVITY_LOG_MODE: "sync" as const,
    ACTIVITY_LOG_BATCH_SIZE: 20,
    ACTIVITY_LOG_BATCH_MAX_AGE_MS: 5000,
    ACTIVITY_LOG_QUEUE_LIMIT: 500,
    AGENT_WAKE_ENABLED: true,
    AGENT_BYPASS_PERMISSIONS: true,
    COORDINATOR_MAX_CONCURRENT_TASKS: 1,
    AGENT_CHAT_MAX_TURNS: 50,
    AGENT_MAX_REVIEW_ITERATIONS: 3,
    AGENT_AUTO_REVIEW_STRATEGY: "full_re_review" as const,
    AGENT_USE_SUBAGENTS: true,
    AGENT_FIRST_ACTIVITY_TIMEOUT_MS: 60_000,
    AIF_ENABLE_CODEX_LOGIN_PROXY: false,
    AIF_CODEX_LOGIN_BROKER_PORT: 3010,
    AIF_CODEX_LOGIN_LOOPBACK_PORT: 1455,
    AGENT_INTERNAL_URL: "http://agent:3010",
    ...overrides,
  };
}

function insertTestTask() {
  testDb.current
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Test", rootPath: "/tmp/test" })
    .run();
  testDb.current
    .insert(tasks)
    .values({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Test Task",
      status: "planning",
      position: 0,
    })
    .run();
}

function getTaskLog(taskId: string = TASK_ID): string {
  const task = testDb.current.select().from(tasks).where(eq(tasks.id, taskId)).get();
  return task?.agentActivityLog ?? "";
}

describe("hooks - activity logging", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    insertTestTask();
    vi.clearAllMocks();
  });

  afterEach(() => {
    disposeActivityQueue(TASK_ID);
  });

  describe("sync mode", () => {
    beforeEach(() => {
      mockedGetEnv.mockReturnValue(makeEnv({ ACTIVITY_LOG_MODE: "sync" }));
    });

    it("writes each entry to DB immediately", () => {
      logActivity(TASK_ID, "Tool", "bash: ls");
      logActivity(TASK_ID, "Tool", "bash: pwd");

      const log = getTaskLog();
      expect(log).toContain("Tool: bash: ls");
      expect(log).toContain("Tool: bash: pwd");
      // Two lines = two entries
      expect(log.split("\n")).toHaveLength(2);
    });

    it("includes timestamp in each entry", () => {
      logActivity(TASK_ID, "Agent", "started planning");
      const log = getTaskLog();
      // Matches ISO timestamp pattern
      expect(log).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("batch mode", () => {
    beforeEach(() => {
      mockedGetEnv.mockReturnValue(
        makeEnv({
          ACTIVITY_LOG_MODE: "batch",
          ACTIVITY_LOG_BATCH_SIZE: 3,
          ACTIVITY_LOG_BATCH_MAX_AGE_MS: 60000, // high so timer doesn't fire
          ACTIVITY_LOG_QUEUE_LIMIT: 10,
        }),
      );
    });

    it("does not write to DB until batch size is reached", () => {
      logActivity(TASK_ID, "Tool", "bash: ls");
      logActivity(TASK_ID, "Tool", "bash: pwd");

      // Only 2 entries, batch size is 3 — should NOT have flushed
      const log = getTaskLog();
      expect(log).toBe("");
    });

    it("flushes when batch size is reached", () => {
      logActivity(TASK_ID, "Tool", "entry 1");
      logActivity(TASK_ID, "Tool", "entry 2");
      logActivity(TASK_ID, "Tool", "entry 3"); // triggers flush at size 3

      const log = getTaskLog();
      expect(log).toContain("entry 1");
      expect(log).toContain("entry 2");
      expect(log).toContain("entry 3");
    });

    it("manual flush writes buffered entries", () => {
      logActivity(TASK_ID, "Tool", "buffered 1");
      logActivity(TASK_ID, "Tool", "buffered 2");

      // Not flushed yet
      expect(getTaskLog()).toBe("");

      // Manual flush
      flushActivityQueue(TASK_ID);

      const log = getTaskLog();
      expect(log).toContain("buffered 1");
      expect(log).toContain("buffered 2");
    });

    it("flushAllActivityQueues flushes all tasks", () => {
      // Create a second task
      const TASK_ID_2 = "test-task-2";
      testDb.current
        .insert(tasks)
        .values({
          id: TASK_ID_2,
          projectId: PROJECT_ID,
          title: "Test Task 2",
          status: "planning",
          position: 1,
        })
        .run();

      logActivity(TASK_ID, "Tool", "task1-entry");
      logActivity(TASK_ID_2, "Tool", "task2-entry");

      // Neither flushed
      expect(getTaskLog()).toBe("");

      flushAllActivityQueues();

      expect(getTaskLog()).toContain("task1-entry");
      expect(getTaskLog(TASK_ID_2)).toContain("task2-entry");

      disposeActivityQueue(TASK_ID_2);
    });

    it("drops oldest entry when queue limit is reached", () => {
      mockedGetEnv.mockReturnValue(
        makeEnv({
          ACTIVITY_LOG_MODE: "batch",
          ACTIVITY_LOG_BATCH_SIZE: 100, // high so it won't auto-flush
          ACTIVITY_LOG_BATCH_MAX_AGE_MS: 60000,
          ACTIVITY_LOG_QUEUE_LIMIT: 3,
        }),
      );

      logActivity(TASK_ID, "Tool", "oldest");
      logActivity(TASK_ID, "Tool", "middle");
      logActivity(TASK_ID, "Tool", "newest");
      // Queue full, next push should drop "oldest"
      logActivity(TASK_ID, "Tool", "after-limit");

      flushActivityQueue(TASK_ID);

      const log = getTaskLog();
      expect(log).not.toContain("oldest");
      expect(log).toContain("middle");
      expect(log).toContain("newest");
      expect(log).toContain("after-limit");
    });

    it("disposeActivityQueue flushes and cleans up", () => {
      logActivity(TASK_ID, "Tool", "before-dispose");

      disposeActivityQueue(TASK_ID);

      const log = getTaskLog();
      expect(log).toContain("before-dispose");

      // Further flush should be a no-op (queue cleared)
      flushActivityQueue(TASK_ID);
    });
  });
});

describe("sanitizeForActivityLog", () => {
  it("returns single-line strings unchanged", () => {
    expect(sanitizeForActivityLog("git status")).toBe("git status");
  });

  it("truncates multiline strings to first line with count", () => {
    const multiline = "git commit -m \"$(cat <<'EOF'\nFix bug\n\nCo-Authored-By: ...\nEOF\n)\"";
    const result = sanitizeForActivityLog(multiline);
    expect(result).toContain("git commit -m \"$(cat <<'EOF'");
    expect(result).toMatch(/\[\+\d+ lines\]$/);
  });

  it("handles heredoc-style commands cleanly", () => {
    const heredoc = "git commit -m \"$(cat <<'EOF'\ncommit message\nEOF\n)\"";
    const result = sanitizeForActivityLog(heredoc);
    expect(result).not.toContain("\\n");
    expect(result).not.toContain("EOF\n)");
  });

  it("respects maxLen parameter", () => {
    const long = "a".repeat(300);
    expect(sanitizeForActivityLog(long, 50).length).toBeLessThanOrEqual(60);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeForActivityLog("")).toBe("");
    expect(sanitizeForActivityLog("\n\n")).toBe("");
  });

  it("strips blank lines from line count", () => {
    const input = "line1\n\nline2\n\nline3";
    const result = sanitizeForActivityLog(input);
    expect(result).toBe("line1 [+2 lines]");
  });
});
