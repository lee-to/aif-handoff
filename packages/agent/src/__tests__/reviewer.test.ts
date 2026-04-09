import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const executeSubagentQueryMock = vi.fn();
const startHeartbeatMock = vi.fn();
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
  startHeartbeat: startHeartbeatMock,
}));

vi.mock("../hooks.js", () => ({
  logActivity: logActivityMock,
}));

const { runReviewer } = await import("../subagents/reviewer.js");

describe("runReviewer", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    executeSubagentQueryMock.mockReset();
    startHeartbeatMock.mockReset();
    logActivityMock.mockReset();
    startHeartbeatMock.mockReturnValue(setInterval(() => undefined, 60_000));

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: "/tmp/reviewer-test",
      })
      .run();
  });

  it("uses native subagent workflows for review sidecars when subagents are enabled", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "review",
        useSubagents: true,
        implementationLog: "Implemented",
      })
      .run();

    executeSubagentQueryMock
      .mockResolvedValueOnce({ resultText: "Review OK" })
      .mockResolvedValueOnce({ resultText: "Security OK" });

    await runReviewer("task-1", "/tmp/reviewer-test");

    expect(executeSubagentQueryMock).toHaveBeenCalledTimes(2);
    const reviewCall = executeSubagentQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const securityCall = executeSubagentQueryMock.mock.calls[1]?.[0] as Record<string, unknown>;

    expect(reviewCall.agentName).toBe("review-sidecar");
    expect(reviewCall.agent).toBe("review-sidecar");
    expect(reviewCall.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "native_subagents",
        sessionReusePolicy: "new_session",
      }),
    );

    expect(securityCall.agentName).toBe("security-sidecar");
    expect(securityCall.agent).toBe("security-sidecar");
    expect(securityCall.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "native_subagents",
        sessionReusePolicy: "new_session",
      }),
    );

    const updatedTask = testDb.current.select().from(tasks).where(eq(tasks.id, "task-1")).get();
    expect(updatedTask?.reviewComments).toContain("## Code Review");
    expect(updatedTask?.reviewComments).toContain("Review OK");
    expect(updatedTask?.reviewComments).toContain("## Security Audit");
    expect(updatedTask?.reviewComments).toContain("Security OK");
  });

  it("uses standard skill mode when subagents are disabled", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-2",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "review",
        useSubagents: false,
        implementationLog: "Implemented",
      })
      .run();

    executeSubagentQueryMock
      .mockResolvedValueOnce({ resultText: "Review OK" })
      .mockResolvedValueOnce({ resultText: "Security OK" });

    await runReviewer("task-2", "/tmp/reviewer-test");

    const reviewCall = executeSubagentQueryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const securityCall = executeSubagentQueryMock.mock.calls[1]?.[0] as Record<string, unknown>;

    expect(reviewCall.agentName).toBe("aif-review");
    expect(reviewCall.agent).toBeUndefined();
    expect(reviewCall.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "standard",
        sessionReusePolicy: "new_session",
      }),
    );

    expect(securityCall.agentName).toBe("aif-security-checklist");
    expect(securityCall.agent).toBeUndefined();
    expect(securityCall.workflowSpec).toEqual(
      expect.objectContaining({
        executionMode: "standard",
        sessionReusePolicy: "new_session",
      }),
    );
  });
});
