import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, taskComments, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const queryMock = vi.fn();
(globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
  queryMock;

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
  let projectRoot: string;

  beforeEach(() => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    testDb.current = createTestDb();
    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("Implementation done"));
    projectRoot = mkdtempSync(join(tmpdir(), "aif-implementer-test-"));

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: projectRoot,
      })
      .run();
  });

  it("skips execution when all plan tasks are complete and rework is not requested", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [x] Task 1: Done",
        reworkRequested: false,
      })
      .run();

    await runImplementer("task-1", projectRoot);

    expect(queryMock).not.toHaveBeenCalled();
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(updatedTask?.implementationLog).toContain("No pending tasks detected in plan");
  });

  it("surfaces a loud rework header and injects the latest comment when rework is requested", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-2",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [x] Done",
        reworkRequested: true,
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-1",
        taskId: "task-2",
        author: "agent",
        message: "agent-msg",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-2",
        taskId: "task-2",
        author: "human",
        message: "first-human",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:01.000Z",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-3",
        taskId: "task-2",
        author: "human",
        message: "latest-human",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:02.000Z",
      })
      .run();

    await runImplementer("task-2", projectRoot);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };

    // Rework header is the very first content of the coordinator prompt
    const firstLine = call.prompt.split("\n")[0] ?? "";
    expect(firstLine.startsWith("====")).toBe(true);
    expect(call.prompt).toContain("REWORK REQUEST — THIS IS THE PRIMARY TASK");
    expect(call.prompt).toContain("<<<REWORK_COMMENT");
    expect(call.prompt).toContain("\nREWORK_COMMENT\n");
    expect(call.prompt).toContain("Rework handling protocol:");

    // Coordinator lead line is still present further down the prompt
    expect(call.prompt).toContain("Implement the task using the provided plan.");
    expect(call.prompt).toContain("HANDOFF_MODE: 1");
    expect(call.prompt).toContain("HANDOFF_TASK_ID: task-2");
    expect(call.prompt).toContain("HANDOFF_SKIP_REVIEW: 0");
    expect(call.prompt).toContain("Autonomous Handoff mode: true.");
    expect(call.prompt).toContain("Do not perform Handoff MCP sync yourself.");
    expect(call.prompt).toContain("Plan path:\n@.ai-factory/PLAN.md");
    expect(call.prompt).toContain("Rework mode: true");
    expect(call.prompt).toContain("message: latest-human");
    expect(call.prompt).not.toContain("message: first-human");
    expect(call.prompt).not.toContain("message: agent-msg");

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(updatedTask?.reworkRequested).toBe(false);
    expect(updatedTask?.implementationLog).toBe("Implementation done");
  });

  it("does NOT resume a stored session when rework is requested", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-rework-no-resume",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [x] Done",
        reworkRequested: true,
        sessionId: "old-session-abc",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-rework-no-resume",
        taskId: "task-rework-no-resume",
        author: "human",
        message: "please fix the login bug",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:01.000Z",
      })
      .run();

    await runImplementer("task-rework-no-resume", projectRoot);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: { resume?: string };
    };
    expect(call.options.resume).toBeUndefined();
  });

  it("resumes a stored session in the standard (non-rework) implement flow", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-normal-resume",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "Plan:\n- remove old code\n- update docs",
        reworkRequested: false,
        sessionId: "session-xyz",
      })
      .run();

    await runImplementer("task-normal-resume", projectRoot);

    expect(queryMock).toHaveBeenCalled();
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: { resume?: string };
    };
    expect(call.options.resume).toBe("session-xyz");
  });

  it("does not skip when checkbox Task checklist has pending items", async () => {
    const db = testDb.current;
    queryMock
      .mockReturnValueOnce(streamSuccess("Implementation done"))
      .mockReturnValueOnce(
        streamSuccess("## Fix Steps\n- [x] Task 1: Pending step\n- [x] Task 2: Done step"),
      );

    db.insert(tasks)
      .values({
        id: "task-3",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Fix Steps\n- [ ] Task 1: Pending step\n- [x] Task 2: Done step",
        reworkRequested: false,
      })
      .run();

    await runImplementer("task-3", projectRoot);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    const firstLine = call.prompt.split("\n")[0] ?? "";
    expect(firstLine).toBe("Implement the task using the provided plan.");
    expect(call.prompt).toContain("Implement the task using the provided plan.");
    expect(call.prompt).toContain("HANDOFF_MODE: 1");
    expect(call.prompt).toContain("HANDOFF_TASK_ID: task-3");
    expect(call.prompt).toContain("HANDOFF_SKIP_REVIEW: 0");
    const syncCall = queryMock.mock.calls[1]?.[0] as { prompt: string };
    expect(syncCall.prompt).toContain("Update only checkbox states");
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-3")).get();
    expect(updatedTask?.implementationLog).toContain("Implementation done");
    expect(updatedTask?.implementationLog).toContain("Plan checklist auto-synced");
    expect(updatedTask?.implementationLog).not.toContain("No pending tasks detected in plan");
  });

  it("does not skip when plan task format is unrecognized", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-4",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "Plan:\n- remove old code\n- update docs",
        reworkRequested: false,
      })
      .run();

    await runImplementer("task-4", projectRoot);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    const firstLine = call.prompt.split("\n")[0] ?? "";
    expect(firstLine).toBe("Implement the task using the provided plan.");
    expect(call.prompt).toContain("Implement the task using the provided plan.");
    expect(call.prompt).toContain("HANDOFF_MODE: 1");
    expect(call.prompt).toContain("HANDOFF_TASK_ID: task-4");
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-4")).get();
    expect(updatedTask?.implementationLog).toBe("Implementation done");
  });

  it("does not fail when checkbox Task checklist remains pending after auto-sync", async () => {
    const db = testDb.current;
    queryMock
      .mockReturnValueOnce(streamSuccess("Implementation done"))
      .mockReturnValueOnce(streamSuccess("## Plan\n- [ ] Task 1: Still pending"));

    db.insert(tasks)
      .values({
        id: "task-5",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [ ] Task 1: Still pending",
        reworkRequested: false,
      })
      .run();

    await expect(runImplementer("task-5", projectRoot)).resolves.toBeUndefined();

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-5")).get();
    expect(updatedTask?.implementationLog).toContain("Implementation done");
    expect(updatedTask?.implementationLog).toContain(
      "Checklist remains incomplete after auto-sync",
    );
  });

  it("uses /aif-implement command format only in skill mode", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skill-impl",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [ ] Task 1: Pending",
        reworkRequested: false,
        useSubagents: false,
      })
      .run();

    await runImplementer("task-skill-impl", projectRoot);

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
    expect(call.prompt).not.toContain("HANDOFF_MODE: 1");
  });

  it("passes HANDOFF_SKIP_REVIEW=1 in native mode when skipReview is enabled", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skip-review",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [ ] Task 1: Pending",
        reworkRequested: false,
        useSubagents: true,
        skipReview: true,
      })
      .run();

    await runImplementer("task-skip-review", projectRoot);

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("HANDOFF_SKIP_REVIEW: 1");
  });

  it("applies rework header and disables resume in skill mode", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skill-rework",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "implementing",
        plan: "## Plan\n- [x] Done",
        reworkRequested: true,
        useSubagents: false,
        sessionId: "skill-old-session",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-skill-rework",
        taskId: "task-skill-rework",
        author: "human",
        message: "skill-rework-request",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:01.000Z",
      })
      .run();

    await runImplementer("task-skill-rework", projectRoot);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: { resume?: string };
    };

    // Slash command stays on the first line so Claude Code can expand it
    const firstLine = call.prompt.split("\n")[0] ?? "";
    expect(firstLine).toBe("/aif-implement @.ai-factory/PLAN.md");

    // Rework header + comment + protocol are still injected into the body
    expect(call.prompt).toContain("REWORK REQUEST — THIS IS THE PRIMARY TASK");
    expect(call.prompt).toContain("<<<REWORK_COMMENT");
    expect(call.prompt).toContain("message: skill-rework-request");
    expect(call.prompt).toContain("Rework handling protocol:");
    expect(call.prompt).toContain("Rework mode: true");

    // Stored session must NOT be resumed for rework, even in skill mode
    expect(call.options.resume).toBeUndefined();
  });
});
