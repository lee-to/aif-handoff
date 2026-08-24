import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@aif/shared/browser";
import { TaskQA } from "@/components/task/TaskQA";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  title: "QA task",
  description: "",
  attachments: [],
  autoMode: true,
  executionOwner: "ai",
  ownershipRevision: 0,
  assignees: [],
  isFix: false,
  plannerMode: "full",
  planPath: ".ai-factory/plans/qa.md",
  planDocs: false,
  planTests: true,
  skipReview: false,
  useSubagents: false,
  runPlanImprove: false,
  runPostVerify: false,
  autoQa: false,
  autoQaCheck: false,
  qaChangeSummary: null,
  qaTestPlan: null,
  qaTestCases: null,
  qaStatus: "idle",
  qaCheckReport: null,
  qaCheckStatus: "idle",
  qaCheckPlaywrightConfigured: null,
  status: "done",
  priority: 0,
  position: 1000,
  plan: null,
  implementationLog: null,
  reviewComments: null,
  agentActivityLog: null,
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  roadmapAlias: null,
  tags: [],
  reworkRequested: false,
  reviewIterationCount: 0,
  maxReviewIterations: 3,
  manualReviewRequired: false,
  autoReviewState: null,
  paused: false,
  lastHeartbeatAt: null,
  lastSyncedAt: null,
  sessionId: null,
  scheduledAt: null,
  branchName: "feature/qa",
  worktreePath: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

function renderTask(overrides: Partial<Task> = {}) {
  const onRunQa = vi.fn();
  const onRunQaCheck = vi.fn();
  render(
    <TaskQA
      task={{ ...task, ...overrides }}
      onRunQa={onRunQa}
      onRunQaCheck={onRunQaCheck}
      isRunning={overrides.qaStatus === "running"}
      isQaCheckRunning={overrides.qaCheckStatus === "running"}
    />,
  );
  return { onRunQa, onRunQaCheck };
}

describe("TaskQA", () => {
  it("requires generated test cases before QA Check can run", () => {
    renderTask();

    expect(screen.getByRole("button", { name: "Run QA Check" })).toBeDisabled();
    expect(screen.getByText("Generate test cases first.")).toBeInTheDocument();
  });

  it("runs non-browser QA Check even when Playwright MCP was not configured", () => {
    const { onRunQaCheck } = renderTask({
      qaTestCases: "# Test Cases\n\n## TC-001",
      qaCheckPlaywrightConfigured: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Run QA Check" }));

    expect(onRunQaCheck).toHaveBeenCalledOnce();
    expect(screen.getByText(/Browser cases may be Blocked/)).toBeInTheDocument();
  });

  it("shows the running state without a previous QA Check report", () => {
    renderTask({
      qaTestCases: "# Test Cases",
      qaCheckStatus: "running",
    });

    expect(screen.getByRole("button", { name: /Checking/ })).toBeDisabled();
    expect(screen.queryByText("TC-001: Pass")).not.toBeInTheDocument();
  });
});
