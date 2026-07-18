import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const executeSubagentQueryMock = vi.fn();
const logActivityMock = vi.fn();

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../subagentQuery.js", () => ({
  executeSubagentQuery: executeSubagentQueryMock,
}));

vi.mock("../hooks.js", () => ({
  logActivity: logActivityMock,
}));

const { runVerifier } = await import("../subagents/verifier.js");

describe("runVerifier", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    executeSubagentQueryMock.mockReset();
    logActivityMock.mockReset();

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: "/tmp/verifier-test",
        reviewSidecarMaxBudgetUsd: 3,
      })
      .run();
  });

  it("runs aif-verify in standard slash-command mode and appends verification output", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "verify",
        reviewComments: "## Code Review\n\nLooks good",
      })
      .run();

    executeSubagentQueryMock.mockResolvedValueOnce({
      resultText:
        'Verification passed\n\n```aif-gate-result\n{"status":"pass","blocking":false}\n```',
    });

    await runVerifier("task-1", "/tmp/verifier-test");

    expect(executeSubagentQueryMock).toHaveBeenCalledTimes(1);
    const call = executeSubagentQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agentName).toBe("aif-verify");
    expect(call.profileMode).toBe("review");
    expect(call.maxBudgetUsd).toBe(3);
    expect(call.fallbackSlashCommand).toBe("/aif-verify");
    expect(call.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "standard",
        sessionReusePolicy: "new_session",
      }),
    );

    const updatedTask = testDb.current.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(updatedTask?.reviewComments).toContain("## Code Review");
    expect(updatedTask?.reviewComments).toContain("## Verification");
    expect(updatedTask?.reviewComments).toContain("Verification passed");
    expect(logActivityMock).toHaveBeenCalledWith(
      "task-1",
      "Agent",
      "verify stage complete (aif-verify)",
    );
  });

  it("throws when the structured verify gate is blocking", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-blocked",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "verify",
      })
      .run();

    executeSubagentQueryMock.mockResolvedValueOnce({
      resultText:
        'Verification failed\n\n```aif-gate-result\n{"status":"fail","blocking":true,"blockers":["missing test"]}\n```',
    });

    await expect(runVerifier("task-blocked", "/tmp/verifier-test")).rejects.toThrow(
      "Verify stage returned a blocking gate result",
    );
  });
});
