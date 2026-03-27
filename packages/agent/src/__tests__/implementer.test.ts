import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, projects, taskComments, tasks } from "@aif/shared";

const testDb = { current: createTestDb() };
const queryMock = vi.fn();

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const { runImplementer } = await import("../subagents/implementer.js");

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

describe("runImplementer rework behavior", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("Implementation done"));

    testDb.current.insert(projects).values({
      id: "project-1",
      name: "Test",
      rootPath: "/tmp/implementer-test",
    }).run();
  });

  it("skips execution when all plan tasks are complete and rework is not requested", async () => {
    const db = testDb.current;
    db.insert(tasks).values({
      id: "task-1",
      projectId: "project-1",
      title: "Task",
      description: "Desc",
      status: "implementing",
      plan: "## Plan\n1. [x] Done",
      reworkRequested: false,
    }).run();

    await runImplementer("task-1", "/tmp/implementer-test");

    expect(queryMock).not.toHaveBeenCalled();
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(updatedTask?.implementationLog).toContain("No pending tasks detected in plan");
  });

  it("executes and injects latest human comment when rework is requested", async () => {
    const db = testDb.current;
    db.insert(tasks).values({
      id: "task-2",
      projectId: "project-1",
      title: "Task",
      description: "Desc",
      status: "implementing",
      plan: "## Plan\n- [x] Done",
      reworkRequested: true,
    }).run();
    db.insert(taskComments).values({
      id: "c-1",
      taskId: "task-2",
      author: "agent",
      message: "agent-msg",
      attachments: "[]",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).run();
    db.insert(taskComments).values({
      id: "c-2",
      taskId: "task-2",
      author: "human",
      message: "first-human",
      attachments: "[]",
      createdAt: "2026-01-01T00:00:01.000Z",
    }).run();
    db.insert(taskComments).values({
      id: "c-3",
      taskId: "task-2",
      author: "human",
      message: "latest-human",
      attachments: "[]",
      createdAt: "2026-01-01T00:00:02.000Z",
    }).run();

    await runImplementer("task-2", "/tmp/implementer-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("Rework mode: true");
    expect(call.prompt).toContain("message: latest-human");
    expect(call.prompt).not.toContain("message: first-human");
    expect(call.prompt).not.toContain("message: agent-msg");

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(updatedTask?.reworkRequested).toBe(false);
    expect(updatedTask?.implementationLog).toBe("Implementation done");
  });

  it("does not skip when numbered checklist has pending items", async () => {
    const db = testDb.current;
    db.insert(tasks).values({
      id: "task-3",
      projectId: "project-1",
      title: "Task",
      description: "Desc",
      status: "implementing",
      plan: "## Fix Steps\n1. [ ] Pending step\n2. [x] Done step",
      reworkRequested: false,
    }).run();

    await runImplementer("task-3", "/tmp/implementer-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("Parsed plan tasks (status + dependencies extracted by orchestrator):");
    expect(call.prompt).toContain("Task 1 [pending]");
    expect(call.prompt).toContain("Task 2 [completed]");
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-3")).get();
    expect(updatedTask?.implementationLog).toBe("Implementation done");
    expect(updatedTask?.implementationLog).not.toContain("No pending tasks detected in plan");
  });

  it("does not skip when plan task format is unrecognized", async () => {
    const db = testDb.current;
    db.insert(tasks).values({
      id: "task-4",
      projectId: "project-1",
      title: "Task",
      description: "Desc",
      status: "implementing",
      plan: "Plan:\n- remove old code\n- update docs",
      reworkRequested: false,
    }).run();

    await runImplementer("task-4", "/tmp/implementer-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain(
      "No structured checklist/tasks were parsed from plan. " +
      "Interpret the plan text directly and decide actionable implementation steps."
    );
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-4")).get();
    expect(updatedTask?.implementationLog).toBe("Implementation done");
  });
});
