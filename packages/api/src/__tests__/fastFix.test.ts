import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunApiRuntimeOneShot = vi.fn();
const incrementTaskTokenUsage = vi.fn();
const findTaskById = vi.fn();

vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
}));

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  return {
    ...actual,
    incrementTaskTokenUsage,
    findTaskById: (taskId: string) => findTaskById(taskId),
  };
});

const { runFastFixQuery, withTimeout } = await import("../services/fastFix.js");

function runtimeResult(outputText: string, usage?: Record<string, number>) {
  return {
    result: {
      outputText,
      usage: usage
        ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            costUsd: usage.costUsd ?? 0,
          }
        : undefined,
    },
    context: {},
  };
}

describe("fastFix service", () => {
  beforeEach(() => {
    mockRunApiRuntimeOneShot.mockReset();
    incrementTaskTokenUsage.mockReset();
    findTaskById.mockReset();
    findTaskById.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
    });
  });

  it("returns plan text on success and records usage", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue(
      runtimeResult("## Plan\n- Updated", {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costUsd: 0.002,
      }),
    );

    const updated = await runFastFixQuery({
      taskId: "task-1",
      taskTitle: "Task",
      taskDescription: "Desc",
      latestComment: {
        author: "human",
        message: "Please update",
        attachments: "[]",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Old plan",
    });

    expect(updated).toBe("## Plan\n- Updated");
    expect(mockRunApiRuntimeOneShot).toHaveBeenCalledTimes(1);
    expect(incrementTaskTokenUsage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ total_tokens: 30, total_cost_usd: 0.002 }),
    );
  });

  it("uses fallback prompt mode when file update is disabled", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue(runtimeResult("## Full updated plan"));

    await runFastFixQuery({
      taskId: "task-2",
      taskTitle: "Task 2",
      taskDescription: "Desc 2",
      latestComment: {
        author: "human",
        message: "Fix quickly",
        attachments: "[]",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
      priorAttempt: "too short",
      shouldTryFileUpdate: false,
    });

    const callArg = mockRunApiRuntimeOneShot.mock.calls[0]?.[0] as {
      prompt: string;
      systemPromptAppend?: string;
    };
    expect(callArg.prompt).toContain("PRIOR_ATTEMPT");
    expect(callArg.prompt).toContain("Do not use tools/subagents");
    expect(callArg.prompt).toContain("@.ai-factory/PLAN.md");
    expect(callArg.systemPromptAppend).toContain("Do not use tools or subagents");
  });

  it("builds prior-attempt prompt with file-update instructions and attachment previews", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue(runtimeResult("## Updated plan with file write"));

    await runFastFixQuery({
      taskId: "task-2b",
      taskTitle: "Task 2b",
      taskDescription: "Desc 2b",
      latestComment: {
        author: "human",
        message: "Use attached snippet",
        attachments: JSON.stringify([
          {
            name: "snippet.txt",
            mimeType: "text/plain",
            size: 12,
            content: "line-1\nline-2",
          },
        ]),
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
      priorAttempt: "still too short",
      shouldTryFileUpdate: true,
    });

    const callArg = mockRunApiRuntimeOneShot.mock.calls[0]?.[0] as {
      prompt: string;
      systemPromptAppend?: string;
    };
    expect(callArg.prompt).toContain("PRIOR_ATTEMPT");
    expect(callArg.prompt).toContain("Also update the plan file @.ai-factory/PLAN.md");
    expect(callArg.prompt).toContain("line-1");
    expect(callArg.systemPromptAppend).toBeUndefined();
  });

  it("marks attachment content as missing when neither inline content nor path is present", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue(runtimeResult("## Updated plan"));

    await runFastFixQuery({
      taskId: "task-2c",
      taskTitle: "Task 2c",
      taskDescription: "Desc 2c",
      latestComment: {
        author: "human",
        message: "Apply from metadata",
        attachments: JSON.stringify([
          {
            name: "context.json",
            mimeType: "application/json",
            size: 100,
            content: null,
          },
        ]),
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
    });

    const callArg = mockRunApiRuntimeOneShot.mock.calls[0]?.[0] as { prompt: string };
    expect(callArg.prompt).toContain("content: [not provided]");
  });

  it("throws when runtime query fails", async () => {
    mockRunApiRuntimeOneShot.mockRejectedValue(new Error("runtime failure"));

    await expect(
      runFastFixQuery({
        taskId: "task-3",
        taskTitle: "Task 3",
        taskDescription: "Desc 3",
        latestComment: {
          author: "human",
          message: "Comment",
          attachments: "[]",
          createdAt: "2026-03-28T00:00:00.000Z",
        },
        projectRoot: process.cwd(),
        planPath: ".ai-factory/PLAN.md",
        previousPlan: "## Previous",
      }),
    ).rejects.toThrow("runtime failure");
  });

  it("throws when runtime returns empty plan text", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue(runtimeResult("   "));

    await expect(
      runFastFixQuery({
        taskId: "task-4",
        taskTitle: "Task 4",
        taskDescription: "Desc 4",
        latestComment: {
          author: "human",
          message: "Comment",
          attachments: "[]",
          createdAt: "2026-03-28T00:00:00.000Z",
        },
        projectRoot: process.cwd(),
        planPath: ".ai-factory/PLAN.md",
        previousPlan: "## Previous",
      }),
    ).rejects.toThrow("did not return updated plan text");
  });

  it("resolves and rejects through withTimeout helper", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "timeout")).resolves.toBe("ok");
    await expect(
      withTimeout(
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 50);
        }),
        1,
        "timed out",
      ),
    ).rejects.toThrow("timed out");
  });
});
