import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "@aif/shared/browser";

const mutateReorder = vi.fn();
const mutateUpdate = vi.fn();

vi.mock("@/hooks/useTasks", () => ({
  useReorderTask: () => ({ mutate: mutateReorder, isPending: false }),
  useUpdateTask: () => ({ mutate: mutateUpdate, isPending: false }),
}));

const { TaskListTable } = await import("@/components/kanban/TaskListTable");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    projectId: "p",
    title: "T",
    description: "",
    autoMode: true,
    isFix: false,
    plannerMode: "fast",
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
    ...overrides,
  };
}

describe("TaskListTable", () => {
  beforeEach(() => {
    mutateReorder.mockClear();
    mutateUpdate.mockClear();
  });

  it("renders Order column with reorder + pause buttons for backlog rows", () => {
    const t = makeTask({ id: "t1", title: "Backlog A" });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={vi.fn()} />);

    expect(screen.getByText("Order")).toBeDefined();
    expect(screen.getByLabelText("Move task up")).toBeDefined();
    expect(screen.getByLabelText("Move task down")).toBeDefined();
    expect(screen.getByLabelText("Pause task")).toBeDefined();
  });

  it("non-backlog rows show em-dash instead of buttons", () => {
    const planning = makeTask({ id: "t1", title: "Planning A", status: "planning" });
    render(<TaskListTable tasks={[planning]} isCompact={false} onTaskClick={vi.fn()} />);

    expect(screen.queryByLabelText("Move task up")).toBeNull();
    expect(screen.getByText("—")).toBeDefined();
  });

  it("reorder up uses midpoint between previous-previous and previous task positions", () => {
    const a = makeTask({ id: "a", position: 100 });
    const b = makeTask({ id: "b", position: 200 });
    const c = makeTask({ id: "c", position: 300 });
    render(<TaskListTable tasks={[a, b, c]} isCompact={false} onTaskClick={vi.fn()} />);

    // Move "c" (last) up — between a (100) and b (200) → 150
    const ups = screen.getAllByLabelText("Move task up");
    fireEvent.click(ups[2]);
    expect(mutateReorder).toHaveBeenCalledWith({ id: "c", position: 150 });
  });

  it("reorder up at top is disabled", () => {
    const a = makeTask({ id: "a", position: 100 });
    const b = makeTask({ id: "b", position: 200 });
    render(<TaskListTable tasks={[a, b]} isCompact={false} onTaskClick={vi.fn()} />);
    const up = screen.getAllByLabelText("Move task up")[0] as HTMLButtonElement;
    expect(up.disabled).toBe(true);
  });

  it("reorder down at bottom is disabled", () => {
    const a = makeTask({ id: "a", position: 100 });
    const b = makeTask({ id: "b", position: 200 });
    render(<TaskListTable tasks={[a, b]} isCompact={false} onTaskClick={vi.fn()} />);
    const downs = screen.getAllByLabelText("Move task down");
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("notifies parent via onReorderBacklog so list view can switch sort to status", () => {
    const onReorder = vi.fn();
    const a = makeTask({ id: "a", position: 100 });
    const b = makeTask({ id: "b", position: 200 });
    render(
      <TaskListTable
        tasks={[a, b]}
        isCompact={false}
        onTaskClick={vi.fn()}
        onReorderBacklog={onReorder}
      />,
    );
    fireEvent.click(screen.getAllByLabelText("Move task down")[0]);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it("pause toggle calls updateTask with the inverse paused value", () => {
    const t = makeTask({ id: "t1" });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Pause task"));
    expect(mutateUpdate).toHaveBeenCalledWith({ id: "t1", input: { paused: true } });
  });

  it("paused backlog row shows Resume button that flips paused back to false", () => {
    const t = makeTask({ id: "t1", paused: true });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Resume task"));
    expect(mutateUpdate).toHaveBeenCalledWith({ id: "t1", input: { paused: false } });
  });

  it("renders scheduled banner in title cell for backlog tasks with scheduledAt", () => {
    const future = "2099-06-15T10:30:00.000Z";
    const t = makeTask({ id: "t1", scheduledAt: future });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={vi.fn()} />);
    expect(screen.getByText(/Starts/)).toBeDefined();
  });

  it("clicking a row triggers onTaskClick (not blocked by Order cell stopPropagation)", () => {
    const onTaskClick = vi.fn();
    const t = makeTask({ id: "t1", title: "Click me" });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={onTaskClick} />);
    fireEvent.click(screen.getByText("Click me"));
    expect(onTaskClick).toHaveBeenCalledWith("t1");
  });

  it("clicking pause does not bubble row click", () => {
    const onTaskClick = vi.fn();
    const t = makeTask({ id: "t1" });
    render(<TaskListTable tasks={[t]} isCompact={false} onTaskClick={onTaskClick} />);
    fireEvent.click(screen.getByLabelText("Pause task"));
    expect(mutateUpdate).toHaveBeenCalled();
    expect(onTaskClick).not.toHaveBeenCalled();
  });
});
