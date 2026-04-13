import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "@aif/shared/browser";
import { TaskDetailHeader } from "@/components/task/TaskDetailHeader";

const baseTask: Task = {
  id: "hdr-1",
  projectId: "proj-1",
  title: "Header Test Task",
  description: "desc",
  attachments: [],
  autoMode: false,
  isFix: false,
  plannerMode: "full",
  planPath: ".ai-factory/PLAN.md",
  planDocs: false,
  planTests: false,
  skipReview: false,
  useSubagents: true,
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
  roadmapAlias: "RM-1",
  tags: ["backend", "rm:ignore"],
  status: "plan_ready",
  priority: 2,
  position: 1000,
  plan: null,
  implementationLog: null,
  reviewComments: null,
  agentActivityLog: null,
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tokenInput: 1234,
  tokenOutput: 567,
  tokenTotal: 1801,
  costUsd: 0.042,
};

describe("TaskDetailHeader", () => {
  it("should render task title and status badge", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Header Test Task")).toBeDefined();
    expect(screen.getByText("Plan Ready")).toBeDefined();
  });

  it("should render priority badge", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("P2")).toBeDefined();
  });

  it("should render roadmap alias badge", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("RM-1")).toBeDefined();
  });

  it("should filter out rm: prefixed tags and roadmap tag", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("backend")).toBeDefined();
    expect(screen.queryByText("rm:ignore")).toBeNull();
  });

  it("should render action buttons for plan_ready manual task", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Start implementation")).toBeDefined();
    expect(screen.getByText("Request replanning")).toBeDefined();
    expect(screen.getByText("Fast fix")).toBeDefined();
  });

  it("should hide actions for auto-mode plan_ready task", () => {
    const autoTask = { ...baseTask, autoMode: true };
    render(
      <TaskDetailHeader
        task={autoTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("Start implementation")).toBeNull();
    expect(screen.queryByText("Request replanning")).toBeNull();
  });

  it("should call onActionClick when action button is clicked", () => {
    const onActionClick = vi.fn();
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={onActionClick}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Start implementation"));
    expect(onActionClick).toHaveBeenCalledWith(
      expect.objectContaining({ event: "start_implementation" }),
    );
  });

  it("should call onTabChange when tab is clicked", () => {
    const onTabChange = vi.fn();
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={onTabChange}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Review"));
    expect(onTabChange).toHaveBeenCalledWith("review");
  });

  it("should show plan change success message", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess="Fast fix applied."
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Fast fix applied.")).toBeDefined();
  });

  it("should render Pause button when task is not paused", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Pause")).toBeDefined();
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("should render manual review badge when human review is required", () => {
    render(
      <TaskDetailHeader
        task={{ ...baseTask, status: "done", manualReviewRequired: true }}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("MANUAL REVIEW")).toBeDefined();
  });

  it("should render Resume button and PAUSED badge when task is paused", () => {
    const pausedTask = { ...baseTask, paused: true };
    render(
      <TaskDetailHeader
        task={pausedTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Resume")).toBeDefined();
    expect(screen.getByText("PAUSED")).toBeDefined();
    expect(screen.queryByText("Pause")).toBeNull();
  });

  it("should call onTogglePaused when pause button is clicked", () => {
    const onTogglePaused = vi.fn();
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={onTogglePaused}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Pause"));
    expect(onTogglePaused).toHaveBeenCalledOnce();
  });

  it("should render token stats", () => {
    render(
      <TaskDetailHeader
        task={baseTask}
        activeTab="implementation"
        onTabChange={vi.fn()}
        onActionClick={vi.fn()}
        onTogglePaused={vi.fn()}
        isDisabled={false}
        isCheckingStartAi={false}
        planChangeSuccess={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/in: 1,234/)).toBeDefined();
    expect(screen.getByText(/out: 567/)).toBeDefined();
  });
});
