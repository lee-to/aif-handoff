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

const { Board } = await import("@/components/kanban/Board");

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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

  it("should render ownership badges", () => {
    render(<Board projectId="test-project" onTaskClick={vi.fn()} density="comfortable" />, {
      wrapper: Wrapper,
    });

    expect(screen.getAllByText("AI controlled").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Human controlled").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Human decision").length).toBeGreaterThan(1);
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
