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
  manualReviewRequired: false,
  autoReviewState: null,
  paused: false,
  lastHeartbeatAt: null,
  lastSyncedAt: null,
  sessionId: null,
  scheduledAt: null,
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

  it("saves planner settings changes (fast mode flips flags to fast defaults, then docs/tests re-enabled)", () => {
    render(<TaskSettings task={mockTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));

    // Switching to Fast auto-flips flags to fast-mode defaults
    // (skipReview=true, planDocs=false, planTests=false).
    fireEvent.click(screen.getByLabelText("Fast"));
    // Re-enable docs and tests manually.
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
      skipReview: true,
    });
  });

  it("preserves saved task values on mount (no auto-flip)", () => {
    const savedTask: Task = {
      ...mockTask,
      plannerMode: "full",
      skipReview: true,
      planDocs: false,
      planTests: false,
    };
    render(<TaskSettings task={savedTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));
    // No Save button — nothing changed on mount.
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("flips flags to full-mode defaults when user manually selects Full", () => {
    const fastTask: Task = {
      ...mockTask,
      plannerMode: "fast",
      skipReview: true,
      planDocs: false,
      planTests: false,
    };
    render(<TaskSettings task={fastTask} onSave={onSave} />);
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByLabelText("Full"));
    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith({
      plannerMode: "full",
      skipReview: false,
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

  describe("scheduled start picker", () => {
    it("is visible only for backlog tasks", () => {
      render(<TaskSettings task={mockTask} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));
      expect(screen.getByText("Scheduled start")).toBeDefined();
    });

    it("is hidden once the task leaves backlog", () => {
      const planning = { ...mockTask, status: "planning" as const };
      render(<TaskSettings task={planning} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));
      expect(screen.queryByText("Scheduled start")).toBeNull();
    });

    it("saves scheduledAt as ISO when user picks a future date", () => {
      render(<TaskSettings task={mockTask} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));

      const futureLocal = "2099-01-15T10:30";
      const picker = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
      expect(picker).not.toBeNull();
      fireEvent.change(picker, { target: { value: futureLocal } });
      fireEvent.click(screen.getByText("Save"));

      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0][0];
      expect(typeof payload.scheduledAt).toBe("string");
      // Local → UTC ISO conversion produces a Z-string
      expect(payload.scheduledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(payload.scheduledAt).getTime()).toBe(new Date(futureLocal).getTime());
    });

    it("saves scheduledAt: null when user clears a previously set schedule", () => {
      const scheduled = { ...mockTask, scheduledAt: "2099-01-15T10:30:00.000Z" };
      render(<TaskSettings task={scheduled} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));

      fireEvent.click(screen.getByText("Clear"));
      fireEvent.click(screen.getByText("Save"));

      expect(onSave).toHaveBeenCalledWith({ scheduledAt: null });
    });
  });

  describe("priority picker", () => {
    it("is rendered with the current priority preselected", () => {
      const high = { ...mockTask, priority: 3 };
      render(<TaskSettings task={high} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));
      // Custom Select shows the selected option's label inside a <span>
      expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    });

    it("emits priority in onSave when changed", () => {
      render(<TaskSettings task={mockTask} onSave={onSave} />);
      fireEvent.click(screen.getByText("Settings"));

      // Open the Select (the trigger button shows the current label)
      fireEvent.click(screen.getByText("None"));
      // Click the "Urgent" option
      fireEvent.click(screen.getByText("Urgent"));
      fireEvent.click(screen.getByText("Save"));

      expect(onSave).toHaveBeenCalledWith({ priority: 4 });
    });
  });
});
