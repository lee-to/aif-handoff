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
  lastHeartbeatAt: null,
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
});
