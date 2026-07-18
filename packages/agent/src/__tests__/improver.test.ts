import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const { runImprover } = await import("../subagents/improver.js");

describe("runImprover", () => {
  let projectRoot: string;
  let planPath: string;

  beforeEach(() => {
    testDb.current = createTestDb();
    executeSubagentQueryMock.mockReset();
    logActivityMock.mockReset();

    projectRoot = mkdtempSync(join(tmpdir(), "aif-improver-test-"));
    mkdirSync(join(projectRoot, ".ai-factory"));
    planPath = join(projectRoot, ".ai-factory", "PLAN.md");
    writeFileSync(planPath, "## Plan\n\n- [ ] Initial task");

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: projectRoot,
        planCheckerMaxBudgetUsd: 2,
      })
      .run();
  });

  it("runs aif-improve in standard slash-command mode and persists the improved plan", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "improve",
        plan: "## Plan\n\n- [ ] Initial task",
        planPath: ".ai-factory/PLAN.md",
      })
      .run();

    executeSubagentQueryMock.mockImplementationOnce(async () => {
      writeFileSync(planPath, "## Plan\n\n- [ ] Initial task\n- [ ] Refined task");
      return { resultText: "Improved" };
    });

    await runImprover("task-1", projectRoot);

    expect(executeSubagentQueryMock).toHaveBeenCalledTimes(1);
    const call = executeSubagentQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agentName).toBe("aif-improve");
    expect(call.profileMode).toBe("plan");
    expect(call.maxBudgetUsd).toBe(2);
    expect(call.fallbackSlashCommand).toBe("/aif-improve @.ai-factory/PLAN.md");
    expect(call.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "standard",
        sessionReusePolicy: "resume_if_available",
      }),
    );

    const updatedTask = testDb.current.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(updatedTask?.plan).toContain("- [ ] Refined task");
    expect(logActivityMock).toHaveBeenCalledWith(
      "task-1",
      "Agent",
      "improve stage complete (aif-improve)",
    );
  });
});
