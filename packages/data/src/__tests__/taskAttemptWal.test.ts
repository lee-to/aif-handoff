import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const beforePlanWrite = vi.hoisted(() => vi.fn());
const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => Object.assign(actual.getEnv(), { AIF_AGENT_ATTEMPT_RECOVERY_ENABLED: true }),
    persistTaskPlan: (input: Parameters<typeof actual.persistTaskPlan>[0]) => {
      beforePlanWrite();
      return actual.persistTaskPlan(input);
    },
  };
});
const { findTaskById, persistTaskPlanForTask, withTaskAttempt, SupersededTaskAttemptError } =
  await import("../index.js");
const storage = await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
let root: string;
let competitor: Database.Database;
const attempt = {
  taskId: "task",
  attemptId: "first",
  coordinatorId: "coordinator",
  ownershipRevision: 0,
};
const persist = (planText: string) =>
  persistTaskPlanForTask({
    taskId: "task",
    planText,
    projectRoot: root,
    isFix: false,
    planPath: "PLAN.md",
  });

beforeEach(() => {
  storage.closeDb();
  root = mkdtempSync(join(tmpdir(), "aif-attempt-wal-"));
  const path = join(root, "test.sqlite");
  testDb.current = storage.getDb(path);
  testDb.current.run(sql`PRAGMA busy_timeout = 0`);
  testDb.current.insert(projects).values({ id: "project", name: "WAL", rootPath: root }).run();
  testDb.current
    .insert(tasks)
    .values({
      id: "task",
      projectId: "project",
      title: "WAL",
      status: "planning",
      stageAttemptId: "first",
      lockedBy: "coordinator",
    })
    .run();
  competitor = new Database(path);
  competitor.pragma("busy_timeout = 0");
  expect(competitor.pragma("journal_mode", { simple: true })).toBe("wal");
  beforePlanWrite.mockReset();
  persist("initial plan");
  beforePlanWrite.mockClear();
});
afterEach(() => {
  competitor.close();
  storage.closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe("attempt fencing across WAL connections", () => {
  it.each(["unrelated write", "competing claim"])(
    "reserves the writer before the plan file against a %s",
    (operation) => {
      let competingError: unknown;
      const compete = () =>
        operation === "unrelated write"
          ? competitor
              .prepare("UPDATE projects SET name = ? WHERE id = ?")
              .run("Changed", "project")
          : competitor
              .prepare("UPDATE tasks SET stage_attempt_id = ? WHERE id = ?")
              .run("replacement", "task");
      beforePlanWrite.mockImplementationOnce(() => {
        try {
          compete();
        } catch (error) {
          competingError = error;
        }
      });
      withTaskAttempt(attempt, () => persist("current attempt plan"));
      expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(findTaskById("task")!.plan).toBe("current attempt plan");
      expect(readFileSync(join(root, "PLAN.md"), "utf8")).toContain("current attempt plan");
      compete();
      if (operation === "competing claim") {
        expect(() => withTaskAttempt(attempt, () => persist("obsolete plan"))).toThrow(
          SupersededTaskAttemptError,
        );
        expect(findTaskById("task")!.plan).toBe("current attempt plan");
        expect(readFileSync(join(root, "PLAN.md"), "utf8")).toContain("current attempt plan");
      }
    },
  );

  it("leaves the database and file intact when another connection already holds the writer", () => {
    competitor.exec("BEGIN IMMEDIATE");
    try {
      expect(() => withTaskAttempt(attempt, () => persist("must not be written"))).toThrow();
      expect(beforePlanWrite).not.toHaveBeenCalled();
      expect(findTaskById("task")!.plan).toBe("initial plan");
      expect(readFileSync(join(root, "PLAN.md"), "utf8")).toContain("initial plan");
    } finally {
      competitor.exec("ROLLBACK");
    }
  });
});
