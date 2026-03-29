import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects, taskComments, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDb = { current: createTestDb() };
const queryMock = vi.fn();

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const { runPlanner } = await import("../subagents/planner.js");

function streamSuccess(result: string): AsyncIterable<{
  type: "result";
  subtype: "success";
  result: string;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result };
    },
  };
}

describe("runPlanner comment selection", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## New Plan\n- [ ] Step"));

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: "/tmp/planner-test",
      })
      .run();
  });

  it("uses only the latest comment in replanning prompt", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "planning",
        plan: "Old plan",
      })
      .run();

    for (let i = 1; i <= 12; i += 1) {
      db.insert(taskComments)
        .values({
          id: `c-${String(i).padStart(2, "0")}`,
          taskId: "task-1",
          author: "human",
          message: `comment-${String(i).padStart(2, "0")}`,
          attachments: "[]",
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        })
        .run();
    }

    await runPlanner("task-1", "/tmp/planner-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("/aif-plan full @.ai-factory/PLAN.md docs:false tests:false");
    expect(call.prompt).toContain("message: comment-12");
    expect(call.prompt).not.toContain("message: comment-11");
    expect(call.prompt).not.toContain("message: comment-01");
  });

  it("breaks same-timestamp ties by id and still uses one latest comment", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-2",
        projectId: "project-1",
        title: "Task 2",
        description: "Desc",
        status: "planning",
        plan: "Old plan",
      })
      .run();

    db.insert(taskComments)
      .values({
        id: "c-1",
        taskId: "task-2",
        author: "human",
        message: "older-by-id",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-2",
        taskId: "task-2",
        author: "human",
        message: "latest-by-id",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    await runPlanner("task-2", "/tmp/planner-test");

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("message: latest-by-id");
    expect(call.prompt).not.toContain("message: older-by-id");

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(updatedTask?.plan).toBe("## New Plan\n- [ ] Step");
  });

  it("uses /aif-fix --plan-first when task is marked as fix", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-fix-1",
        projectId: "project-1",
        title: "Fix login bug",
        description: "Users get 500 on /login",
        status: "planning",
        isFix: true,
      })
      .run();

    await runPlanner("task-fix-1", "/tmp/planner-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: { extraArgs?: { agent?: string } };
    };
    expect(call.prompt).toContain("/aif-fix --plan-first");
    expect(call.prompt).toContain("Fix login bug");
    expect(call.prompt).toContain("Users get 500 on /login");
    expect(call.options.extraArgs).toBeUndefined();
  });

  it("loads plan text from fallback PLAN.md when skill wrote outside canonical plan path", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-fallback-"));
    mkdirSync(projectRoot, { recursive: true });
    const fallbackPlanPath = join(projectRoot, "PLAN.md");
    writeFileSync(fallbackPlanPath, "## Fallback Plan\n- [ ] Step from fallback", "utf8");

    db.insert(projects)
      .values({
        id: "project-fallback",
        name: "Fallback Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-fallback",
        projectId: "project-fallback",
        title: "Task fallback",
        description: "Desc",
        status: "planning",
        planPath: ".ai-factory/PLAN.md",
      })
      .run();

    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("Plan written to PLAN.md"));

    await runPlanner("task-fallback", projectRoot);

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-fallback")).get();
    expect(updatedTask?.plan).toBe("## Fallback Plan\n- [ ] Step from fallback");
  });
});
