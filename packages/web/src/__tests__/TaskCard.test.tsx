import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "@aif/shared/browser";

const { TaskCard } = await import("@/components/kanban/TaskCard");

const mockTask: Task = {
  id: "card-1",
  projectId: "test-project",
  title: "Sample Task",
  description: "A sample description that might be quite long and should be truncated",
  autoMode: true,
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
  branchName: null,
  roadmapAlias: null,
  tags: [],
  status: "backlog",
  priority: 3,
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
};

describe("TaskCard", () => {
  it("should render task title", () => {
    render(<TaskCard task={mockTask} onClick={vi.fn()} />);
    expect(screen.getByText("Sample Task")).toBeDefined();
  });

  it("should render task description", () => {
    render(<TaskCard task={mockTask} onClick={vi.fn()} />);
    expect(screen.getByText(/A sample description/)).toBeDefined();
  });

  it("should render priority badge for priority > 0", () => {
    render(<TaskCard task={mockTask} onClick={vi.fn()} />);
    expect(screen.getByText("High")).toBeDefined();
  });

  it("should not render priority badge for priority 0", () => {
    const noPriority = { ...mockTask, priority: 0 };
    render(<TaskCard task={noPriority} onClick={vi.fn()} />);
    expect(screen.queryByText("None")).toBeNull();
  });

  it("should call onClick when clicked", () => {
    const onClick = vi.fn();
    render(<TaskCard task={mockTask} onClick={onClick} />);
    fireEvent.click(screen.getByText("Sample Task"));
    expect(onClick).toHaveBeenCalled();
  });

  it("should render overlay variant", () => {
    render(<TaskCard task={mockTask} onClick={vi.fn()} overlay />);
    expect(screen.getByText("Sample Task")).toBeDefined();
  });

  it("should render manual review indicators when human review is required", () => {
    render(
      <TaskCard
        task={{ ...mockTask, manualReviewRequired: true, status: "done" }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Manual Review")).toBeDefined();
    expect(screen.getByText("Auto-review stopped. Human review required.")).toBeDefined();
  });

  it("should render structured runtime auto-pause messaging for blocked tasks", () => {
    render(
      <TaskCard
        task={{
          ...mockTask,
          status: "blocked_external",
          retryAfter: "2026-04-17T01:00:00.000Z",
          runtimeLimitSnapshot: {
            source: "api_headers",
            status: "blocked",
            precision: "exact",
            checkedAt: "2026-04-17T00:00:00.000Z",
            providerId: "anthropic",
            runtimeId: "claude",
            primaryScope: "requests",
            resetAt: "2099-04-17T01:00:00.000Z",
            warningThreshold: 10,
            windows: [{ scope: "requests", percentRemaining: 5, warningThreshold: 10 }],
            providerMeta: null,
          },
        }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Runtime auto-pause")).toBeDefined();
    expect(
      screen.getByText("Request quota crossed the 10% safety threshold (5% remaining)."),
    ).toBeDefined();
    expect(screen.getByText(/Provider reset/)).toBeDefined();
    expect(screen.getByText(/Task retry .*scheduled/)).toBeDefined();
  });

  describe("scheduled banner", () => {
    it("renders 'Starts ...' for backlog tasks with scheduledAt", () => {
      const future = "2099-06-15T10:30:00.000Z";
      render(<TaskCard task={{ ...mockTask, scheduledAt: future }} onClick={vi.fn()} />);
      expect(screen.getByText(/Starts/)).toBeDefined();
    });

    it("does not render the banner once the task leaves backlog", () => {
      const future = "2099-06-15T10:30:00.000Z";
      render(
        <TaskCard
          task={{ ...mockTask, scheduledAt: future, status: "planning" }}
          onClick={vi.fn()}
        />,
      );
      expect(screen.queryByText(/Starts/)).toBeNull();
    });
  });

  describe("reorder arrows", () => {
    it("renders up/down buttons only when callbacks are provided in backlog", () => {
      const onMoveUp = vi.fn();
      const onMoveDown = vi.fn();
      render(
        <TaskCard
          task={mockTask}
          onClick={vi.fn()}
          canMoveUp
          canMoveDown
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />,
      );
      fireEvent.click(screen.getByLabelText("Move task up"));
      fireEvent.click(screen.getByLabelText("Move task down"));
      expect(onMoveUp).toHaveBeenCalledTimes(1);
      expect(onMoveDown).toHaveBeenCalledTimes(1);
    });

    it("disables Move up at top of list and Move down at bottom", () => {
      const onMoveUp = vi.fn();
      const onMoveDown = vi.fn();
      render(
        <TaskCard
          task={mockTask}
          onClick={vi.fn()}
          canMoveUp={false}
          canMoveDown={false}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />,
      );
      const up = screen.getByLabelText("Move task up") as HTMLButtonElement;
      const down = screen.getByLabelText("Move task down") as HTMLButtonElement;
      expect(up.disabled).toBe(true);
      expect(down.disabled).toBe(true);
    });

    it("does not render arrows for non-backlog tasks", () => {
      render(
        <TaskCard
          task={{ ...mockTask, status: "planning" }}
          onClick={vi.fn()}
          canMoveUp
          canMoveDown
          onMoveUp={vi.fn()}
          onMoveDown={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText("Move task up")).toBeNull();
    });

    it("clicking arrow does not bubble onClick to the card", () => {
      const cardClick = vi.fn();
      const onMoveUp = vi.fn();
      render(
        <TaskCard
          task={mockTask}
          onClick={cardClick}
          canMoveUp
          canMoveDown
          onMoveUp={onMoveUp}
          onMoveDown={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByLabelText("Move task up"));
      expect(onMoveUp).toHaveBeenCalled();
      expect(cardClick).not.toHaveBeenCalled();
    });
  });

  describe("pause toggle", () => {
    it("calls onTogglePause when Pause clicked on an unpaused backlog task", () => {
      const onTogglePause = vi.fn();
      render(<TaskCard task={mockTask} onClick={vi.fn()} onTogglePause={onTogglePause} />);
      fireEvent.click(screen.getByLabelText("Pause task"));
      expect(onTogglePause).toHaveBeenCalledTimes(1);
    });

    it("shows Resume label and calls onTogglePause when paused", () => {
      const onTogglePause = vi.fn();
      render(
        <TaskCard
          task={{ ...mockTask, paused: true }}
          onClick={vi.fn()}
          onTogglePause={onTogglePause}
        />,
      );
      fireEvent.click(screen.getByLabelText("Resume task"));
      expect(onTogglePause).toHaveBeenCalledTimes(1);
    });

    it("does not render the pause button for non-backlog tasks", () => {
      render(
        <TaskCard
          task={{ ...mockTask, status: "planning" }}
          onClick={vi.fn()}
          onTogglePause={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText("Pause task")).toBeNull();
      expect(screen.queryByLabelText("Resume task")).toBeNull();
    });
  });
});
