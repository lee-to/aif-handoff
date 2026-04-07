import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "@aif/shared/browser";

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({ data: [{ id: "test-project", parallelEnabled: false }] }),
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useRuntimeProfiles: () => ({ data: [] }),
  useRuntimes: () => ({ data: [] }),
}));

const mockTask: Task = {
  id: "ts-1",
  projectId: "test-project",
  title: "Settings Task",
  description: "",
  attachments: [],
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
  paused: false,
  lastHeartbeatAt: null,
  lastSyncedAt: null,
  sessionId: null,
  roadmapAlias: null,
  tags: [],
  status: "backlog",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const { TaskSettings } = await import("@/components/task/TaskSettings");

describe("TaskSettings", () => {
  let onSave: any;

  beforeEach(() => {
    onSave = vi.fn();
  });

  it("renders Settings button when collapsed", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    expect(screen.getByText("Settings")).toBeDefined();
  });

  it("shows settings panel when clicked", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.getByText("Auto mode")).toBeDefined();
    expect(screen.getByText("Skip review")).toBeDefined();
    expect(screen.getByText("Use subagents")).toBeDefined();
  });

  it("shows planner settings for non-fix tasks", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.getByText("Planner")).toBeDefined();
    expect(screen.getByText("Full")).toBeDefined();
    expect(screen.getByText("Fast")).toBeDefined();
    expect(screen.getByText("Docs")).toBeDefined();
    expect(screen.getByText("Tests")).toBeDefined();
  });

  it("hides planner settings for fix tasks", () => {
    const fixTask = { ...mockTask, isFix: true };
    render(<TaskSettings task={fixTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.getByText("Auto mode")).toBeDefined();
    expect(screen.queryByText("Planner")).toBeNull();
  });

  it("saves changed settings", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    // Toggle autoMode off
    fireEvent.click(screen.getByLabelText("Auto mode"));
    // Toggle skipReview on
    fireEvent.click(screen.getByLabelText("Skip review"));

    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({
      autoMode: false,
      skipReview: true,
    });
  });

  it("saves planner settings changes", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    fireEvent.click(screen.getByLabelText("Fast"));
    fireEvent.click(screen.getByLabelText("Docs"));
    fireEvent.click(screen.getByLabelText("Tests"));
    fireEvent.change(screen.getByPlaceholderText(".ai-factory/PLAN.md"), {
      target: { value: ".ai-factory/custom.md" },
    });

    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({
      plannerMode: "fast",
      planPath: ".ai-factory/custom.md",
      planDocs: true,
      planTests: true,
    });
  });

  it("saves useSubagents toggle", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    fireEvent.click(screen.getByLabelText("Use subagents"));
    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({ useSubagents: false });
  });

  it("does not show Save button when no changes", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.queryByText("Save")).toBeNull();
  });

  it("closes and resets on Close button", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    // Make a change
    fireEvent.click(screen.getByLabelText("Auto mode"));
    // Close
    fireEvent.click(screen.getByText("Close"));

    // Should show collapsed button again
    expect(screen.getByText("Settings")).toBeDefined();
    expect(screen.queryByText("Auto mode")).toBeNull();
  });

  it("shows max review iterations input when autoMode is on", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.getByText("Max review iterations")).toBeDefined();
  });

  it("hides max review iterations input when autoMode is off", () => {
    const noAutoTask = { ...mockTask, autoMode: false };
    render(<TaskSettings task={noAutoTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.queryByText("Max review iterations")).toBeNull();
  });

  it("saves maxReviewIterations change", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    const input = screen.getByDisplayValue("3");
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({ maxReviewIterations: 7 });
  });

  it("opens runtime override panel", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Runtime override" }));

    expect(screen.getByText("Runtime profile")).toBeDefined();
    expect(screen.getByPlaceholderText("runtime default")).toBeDefined();
  });

  it("auto-opens runtime override when task has runtimeProfileId", () => {
    const taskWithRuntime = { ...mockTask, runtimeProfileId: "some-profile" };
    render(<TaskSettings task={taskWithRuntime} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    // Panel should already be open
    expect(screen.getByText("Runtime profile")).toBeDefined();
  });

  it("does not include planner fields in save for fix tasks", () => {
    const fixTask = { ...mockTask, isFix: true };
    render(<TaskSettings task={fixTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    fireEvent.click(screen.getByLabelText("Auto mode"));
    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({ autoMode: false });
  });
});
