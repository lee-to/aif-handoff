import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskListItem } from "@aif/shared/browser";

function makeTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: "1",
    projectId: "test-project",
    title: "Test Task 1",
    description: "Description 1",
    autoMode: true,
    executionOwner: "ai",
    ownershipRevision: 0,
    assignees: [],
    isFix: false,
    status: "backlog",
    priority: 1,
    position: 1000,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    tokenInput: 0,
    tokenOutput: 0,
    tokenTotal: 0,
    costUsd: 0,
    roadmapAlias: null,
    tags: [],
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    manualReviewRequired: false,
    paused: false,
    lastSyncedAt: null,
    runtimeProfileId: null,
    modelOverride: null,
    runtimeLimitSnapshot: null,
    runtimeLimitUpdatedAt: null,
    scheduledAt: null,
    hasPlan: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Mock useTasks to return controlled lightweight task list data.
const mockTasks: TaskListItem[] = [
  makeTask(),
  makeTask({
    id: "2",
    title: "Test Task 2",
    description: "Description 2",
    status: "planning",
    priority: 3,
  }),
];

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ data: mockTasks, isLoading: false }),
  useReorderTask: () => ({ mutate: vi.fn() }),
  useTaskEvent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateTaskComment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useTaskComments: () => ({ data: [], isLoading: false }),
  useTask: () => ({ data: null }),
  useUpdateTask: () => ({ mutate: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn() }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    session: {
      participantsModeEnabled: true,
      authenticated: true,
      participant: { id: "member-1", displayName: "Alice", role: "member", active: true },
    },
  }),
}));

const { Board } = await import("@/components/kanban/Board");

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function getColumn(label: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: label });
  const column = heading.parentElement?.parentElement?.parentElement;
  if (!column) throw new Error(`Could not find column for ${label}`);
  return column;
}

function expectTaskBefore(column: HTMLElement, firstTitle: string, secondTitle: string): void {
  const firstTask = within(column).getByText(firstTitle);
  const secondTask = within(column).getByText(secondTitle);

  expect(firstTask.compareDocumentPosition(secondTask) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("Board", () => {
  it("should render status columns", () => {
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByText("Planning")).toBeDefined();
    expect(screen.getByText("Plan Ready")).toBeDefined();
    expect(screen.getByText("Implementing")).toBeDefined();
    expect(screen.getByText("Review")).toBeDefined();
    expect(screen.getByText("Blocked")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
    expect(screen.getByText("Verified")).toBeDefined();
  });

  it("should render task cards in correct columns", () => {
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText("Test Task 1")).toBeDefined();
    expect(screen.getByText("Test Task 2")).toBeDefined();
  });

  it("should bound every card list to the viewport with independent vertical scrolling", () => {
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    for (const label of [
      "Backlog",
      "Planning",
      "Improve",
      "Plan Ready",
      "Implementing",
      "Verify",
      "Review",
      "Blocked",
      "Done",
      "Verified",
    ]) {
      const taskList = getColumn(label).lastElementChild;
      expect(taskList?.className).toContain("max-h-[calc(100vh-");
      expect(taskList?.className).toContain("overflow-y-auto");
      expect(taskList?.className).toContain("overscroll-y-contain");
    }
  });

  it("should show newest terminal tasks first while preserving position order elsewhere", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "verified-newer",
        title: "Verified Newer",
        status: "verified",
        position: 3000,
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      makeTask({
        id: "verified-older",
        title: "Verified Older",
        status: "verified",
        position: 1000,
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
      makeTask({
        id: "done-newer",
        title: "Done Newer",
        status: "done",
        position: 3000,
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      makeTask({
        id: "done-invalid-later-position",
        title: "Done Invalid Later Position",
        status: "done",
        position: 2000,
        updatedAt: "not-a-date",
      }),
      makeTask({
        id: "done-older",
        title: "Done Older",
        status: "done",
        position: 1000,
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
      makeTask({
        id: "done-invalid-earlier-position",
        title: "Done Invalid Earlier Position",
        status: "done",
        position: 1500,
        updatedAt: "also-not-a-date",
      }),
      makeTask({
        id: "planning-later-position",
        title: "Planning Later Position",
        status: "planning",
        position: 3000,
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
      makeTask({
        id: "planning-earlier-position",
        title: "Planning Earlier Position",
        status: "planning",
        position: 2000,
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });
    mockTasks.splice(originalLength);

    expectTaskBefore(getColumn("Verified"), "Verified Newer", "Verified Older");

    const doneColumn = getColumn("Done");
    expectTaskBefore(doneColumn, "Done Newer", "Done Older");
    expectTaskBefore(doneColumn, "Done Older", "Done Invalid Earlier Position");
    expectTaskBefore(doneColumn, "Done Invalid Earlier Position", "Done Invalid Later Position");

    expectTaskBefore(getColumn("Planning"), "Planning Earlier Position", "Planning Later Position");
  });

  it("should render task ownership and assignees", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "human-task",
        title: "Human Task",
        executionOwner: "human",
        assignees: [
          { participantId: "member-1", displayName: "Alice", role: "member", active: true },
        ],
      }),
    );
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    expect(screen.getAllByText("AI owner").length).toBeGreaterThan(0);
    expect(screen.getByText("Human owner")).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
    mockTasks.splice(originalLength);
  });

  it("filters My tasks by authenticated participant assignment", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "mine",
        title: "Assigned to Alice",
        executionOwner: "human",
        assignees: [
          { participantId: "member-1", displayName: "Alice", role: "member", active: true },
        ],
      }),
      makeTask({
        id: "other",
        title: "Assigned to Bob",
        executionOwner: "human",
        assignees: [
          { participantId: "member-2", displayName: "Bob", role: "member", active: true },
        ],
      }),
    );
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("mine"));

    expect(screen.getByText("Assigned to Alice")).toBeDefined();
    expect(screen.queryByText("Assigned to Bob")).toBeNull();
    mockTasks.splice(originalLength);
  });

  it("filters Human-owned tasks by assignee", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "human-alice",
        title: "Alice Human Task",
        executionOwner: "human",
        assignees: [
          { participantId: "member-1", displayName: "Alice", role: "member", active: true },
        ],
      }),
      makeTask({
        id: "human-bob",
        title: "Bob Human Task",
        executionOwner: "human",
        assignees: [
          { participantId: "member-2", displayName: "Bob", role: "member", active: true },
        ],
      }),
    );
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("human-owned"));
    const assigneeFilters = screen.getByTestId("assignee-filters");
    fireEvent.click(within(assigneeFilters).getByText("Bob"));

    expect(screen.queryByText("Alice Human Task")).toBeNull();
    expect(screen.getByText("Bob Human Task")).toBeDefined();
    mockTasks.splice(originalLength);
  });

  it("should show task descriptions", () => {
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText("Description 1")).toBeDefined();
    expect(screen.getByText("Description 2")).toBeDefined();
  });

  it("should render list view", () => {
    render(
      <Board
        projectId="test-project"
        onTaskClick={vi.fn()}
        density="comfortable"
        viewMode="list"
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText("Task")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Test Task 1")).toBeDefined();
    expect(screen.getByText("Test Task 2")).toBeDefined();
  });

  it("should filter no-plan tasks using hasPlan", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({ id: "planned", title: "Planned Task", hasPlan: true }),
      makeTask({ id: "unplanned", title: "Unplanned Task", hasPlan: false }),
    );

    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("no plan"));

    expect(screen.queryByText("Planned Task")).toBeNull();
    expect(screen.getByText("Unplanned Task")).toBeDefined();

    mockTasks.splice(originalLength);
  });

  it("should show roadmap alias sub-filters when roadmap filter is active", () => {
    // Add roadmap tasks to mock data
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "rm-1",
        title: "Roadmap Task A",
        description: "",
        status: "backlog",
        priority: 1,
        position: 2000,
        roadmapAlias: "v1.0",
        tags: ["roadmap", "rm:v1.0"],
      }),
      makeTask({
        id: "rm-2",
        title: "Roadmap Task B",
        description: "",
        status: "backlog",
        priority: 1,
        position: 3000,
        roadmapAlias: "v2.0",
        tags: ["roadmap", "rm:v2.0"],
      }),
    );

    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    // Activate roadmap filter
    fireEvent.click(screen.getByText("roadmap"));

    // Sub-filter row should appear with alias chips
    const aliasRow = screen.getByTestId("roadmap-alias-filters");
    expect(within(aliasRow).getByText("v1.0")).toBeDefined();
    expect(within(aliasRow).getByText("v2.0")).toBeDefined();

    // Both roadmap tasks visible
    expect(screen.getByText("Roadmap Task A")).toBeDefined();
    expect(screen.getByText("Roadmap Task B")).toBeDefined();

    // Click v1.0 alias — only v1.0 tasks should remain
    fireEvent.click(within(aliasRow).getByText("v1.0"));
    expect(screen.getByText("Roadmap Task A")).toBeDefined();
    expect(screen.queryByText("Roadmap Task B")).toBeNull();

    // Click v1.0 again to deselect — both visible again
    fireEvent.click(within(aliasRow).getByText("v1.0"));
    expect(screen.getByText("Roadmap Task A")).toBeDefined();
    expect(screen.getByText("Roadmap Task B")).toBeDefined();

    // Cleanup
    mockTasks.splice(originalLength);
  });

  it("should clear roadmap alias sub-filters when roadmap filter is deactivated", () => {
    const originalLength = mockTasks.length;
    mockTasks.push(
      makeTask({
        id: "rm-3",
        title: "Roadmap Task C",
        description: "",
        status: "backlog",
        priority: 1,
        position: 2000,
        roadmapAlias: "v1.0",
        tags: ["roadmap", "rm:v1.0"],
      }),
    );

    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    // Activate roadmap filter, select alias
    fireEvent.click(screen.getByText("roadmap"));
    const aliasRow = screen.getByTestId("roadmap-alias-filters");
    fireEvent.click(within(aliasRow).getByText("v1.0"));

    // Deactivate roadmap filter
    fireEvent.click(screen.getByText("roadmap"));

    // Sub-filter row should disappear
    expect(screen.queryByTestId("roadmap-alias-filters")).toBeNull();

    // Cleanup
    mockTasks.splice(originalLength);
  });

  it("should filter list view by search query", () => {
    render(
      <Board
        projectId="test-project"
        onTaskClick={vi.fn()}
        density="comfortable"
        viewMode="list"
      />,
      { wrapper: Wrapper },
    );

    const searchInput = screen.getByPlaceholderText("Search by title, description, id, status");
    fireEvent.change(searchInput, { target: { value: "Task 2" } });

    expect(screen.queryByText("Test Task 1")).toBeNull();
    expect(screen.getByText("Test Task 2")).toBeDefined();
  });
});
