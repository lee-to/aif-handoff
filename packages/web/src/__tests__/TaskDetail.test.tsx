import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@aif/shared/browser";

const mockTask: Task = {
  id: "detail-1",
  projectId: "test-project",
  title: "Detail Task",
  description: "Full description here",
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
  status: "implementing",
  priority: 2,
  position: 1000,
  plan: "## Plan\n- Step 1\n- Step 2",
  implementationLog: "Created files X and Y",
  reviewComments: null,
  agentActivityLog: "[2026-01-01] Tool: Read\n[2026-01-01] Tool: Write",
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const mockDoneTask: Task = {
  ...mockTask,
  id: "detail-done",
  status: "done",
  title: "Done Task",
};

const mockDoneFixTask: Task = {
  ...mockDoneTask,
  id: "detail-done-fix",
  isFix: true,
  title: "Done Fix Task",
};

const mockBacklogTask: Task = {
  ...mockTask,
  id: "detail-backlog",
  status: "backlog",
  title: "Backlog Task",
};

const mockBlockedTask: Task = {
  ...mockTask,
  id: "detail-blocked",
  status: "blocked_external",
  title: "Blocked Task",
  blockedFromStatus: "planning",
  blockedReason: "rate limit",
};

const mockPlanReadyManualTask: Task = {
  ...mockTask,
  id: "detail-plan-ready-manual",
  status: "plan_ready",
  autoMode: false,
  title: "Manual Plan Ready",
};

const mockReviewTask: Task = {
  ...mockTask,
  id: "detail-review",
  status: "review",
  title: "Review Task",
  reviewComments: "Looks good after minor cleanup",
};

const mockTaskWithAttachment: Task = {
  ...mockTask,
  id: "detail-with-attachment",
  title: "Attachment Task",
  attachments: [
    {
      name: "old.txt",
      mimeType: "text/plain",
      size: 3,
      content: "old",
    },
  ],
};

const mockTaskNoPlanNoLog: Task = {
  ...mockTask,
  id: "detail-no-plan-no-log",
  title: "No Plan No Log",
  plan: null,
  agentActivityLog: null,
};

const mockPlanningTaskWithActivityOnly: Task = {
  ...mockTask,
  id: "detail-planning-activity",
  status: "planning",
  title: "Planning With Activity",
  implementationLog: null,
  agentActivityLog: "[2026-01-01] Tool: Read spec\n[2026-01-01] Agent: planning started",
};

const mutateUpdateTask = vi.fn();
const mutateDeleteTask = vi.fn();
const mutateTaskEvent = vi.fn();
const mutateCreateComment = vi.fn();
const mutateTaskEventAsync = vi.fn();
const mutateCreateCommentAsync = vi.fn();
const mutateSyncTaskPlan = vi.fn();
const mockGetTaskPlanFileStatus = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getTaskPlanFileStatus: (...args: unknown[]) => mockGetTaskPlanFileStatus(...args),
  },
}));

vi.mock("@/hooks/useTasks", () => ({
  useTask: (id: string | null) => ({
    data:
      id === "detail-1"
        ? mockTask
        : id === "detail-done"
          ? mockDoneTask
          : id === "detail-done-fix"
            ? mockDoneFixTask
            : id === "detail-backlog"
              ? mockBacklogTask
              : id === "detail-blocked"
                ? mockBlockedTask
                : id === "detail-plan-ready-manual"
                  ? mockPlanReadyManualTask
                  : id === "detail-review"
                    ? mockReviewTask
                    : id === "detail-with-attachment"
                      ? mockTaskWithAttachment
                      : id === "detail-no-plan-no-log"
                        ? mockTaskNoPlanNoLog
                        : id === "detail-planning-activity"
                          ? mockPlanningTaskWithActivityOnly
                          : null,
  }),
  useUpdateTask: () => ({ mutate: mutateUpdateTask }),
  useDeleteTask: () => ({ mutate: mutateDeleteTask }),
  useTaskEvent: () => ({
    mutate: mutateTaskEvent,
    mutateAsync: mutateTaskEventAsync,
    isPending: false,
  }),
  useTaskComments: () => ({ data: [], isLoading: false }),
  useCreateTaskComment: () => ({
    mutate: mutateCreateComment,
    mutateAsync: mutateCreateCommentAsync,
    isPending: false,
  }),
  useSyncTaskPlan: () => ({ mutate: mutateSyncTaskPlan, isPending: false }),
}));

const { TaskDetail } = await import("@/components/task/TaskDetail");

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("TaskDetail", () => {
  beforeEach(() => {
    mutateUpdateTask.mockClear();
    mutateDeleteTask.mockClear();
    mutateTaskEvent.mockClear();
    mutateCreateComment.mockClear();
    mutateTaskEventAsync.mockReset();
    mutateCreateCommentAsync.mockReset();
    mutateSyncTaskPlan.mockClear();
    mockGetTaskPlanFileStatus.mockReset();
    mutateTaskEventAsync.mockResolvedValue(undefined);
    mutateCreateCommentAsync.mockResolvedValue(undefined);
    mockGetTaskPlanFileStatus.mockResolvedValue({
      exists: false,
      path: "/tmp/.ai-factory/PLAN.md",
    });
  });

  it("should render nothing when taskId is null", () => {
    const { container } = render(<TaskDetail taskId={null} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });
    // Sheet should not be visible
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("should render task title when open", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("Detail Task")).toBeDefined();
  });

  it("should render task description", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getAllByText("Full description here").length).toBeGreaterThan(0);
  });

  it("should show Settings button for backlog tasks", () => {
    render(<TaskDetail taskId="detail-backlog" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("Settings")).toBeDefined();
  });

  it("should not show Settings button for non-backlog tasks", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("should update task settings from Settings panel", () => {
    render(<TaskDetail taskId="detail-backlog" onClose={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByLabelText("Auto mode"));
    fireEvent.click(screen.getByText("Save"));

    expect(mutateUpdateTask).toHaveBeenCalledWith({
      id: "detail-backlog",
      input: { autoMode: false },
    });
  });

  it("should render implementation log", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Implementation"));
    expect(screen.getAllByText("Created files X and Y").length).toBeGreaterThan(0);
  });

  it("should render agent activity timeline", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Activity"));
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Write").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TOOL").length).toBeGreaterThan(0);
  });

  it("defaults to activity tab when implementation log is empty but agent activity exists", () => {
    render(<TaskDetail taskId="detail-planning-activity" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText(/Agent:\s+planning started/i)).toBeDefined();
    expect(screen.getAllByText("AGENT").length).toBeGreaterThan(0);
  });

  it("should clear agent activity log with confirmation", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Activity"));
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(mutateUpdateTask).toHaveBeenCalledWith(
      {
        id: "detail-1",
        input: { agentActivityLog: null },
      },
      expect.any(Object),
    );
  });

  it("should sync plan from file with confirmation", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Sync" })[1]);

    expect(mutateSyncTaskPlan).toHaveBeenCalledWith("detail-1", expect.any(Object));
  });

  it("should hide clear log and sync buttons when log and plan are missing", () => {
    render(<TaskDetail taskId="detail-no-plan-no-log" onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
    fireEvent.click(screen.getByText("Activity"));
    expect(screen.queryByRole("button", { name: "Clear log" })).toBeNull();
  });

  it("should show delete button", () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getAllByText("Delete task").length).toBeGreaterThan(0);
  });

  it("should show human decision actions for done tasks", () => {
    render(<TaskDetail taskId="detail-done" onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("Approve")).toBeDefined();
    expect(screen.getByText("Request changes")).toBeDefined();
  });

  it("should confirm approve_done and send deletePlanFile=false by default", () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-done" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Approve done task?")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]);

    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-done",
      event: "approve_done",
      deletePlanFile: false,
      commitOnApprove: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should send deletePlanFile=true when checkbox is selected in approve confirmation", () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-done-fix" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Delete plan file (FIX_PLAN.md)")).toBeDefined();
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]); // delete plan file checkbox
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]);

    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-done-fix",
      event: "approve_done",
      deletePlanFile: true,
      commitOnApprove: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should submit request changes with comment for done task", async () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-done" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(screen.getByText("Request Changes")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("Describe what needs to be changed..."), {
      target: { value: "Need to rework implementation details and tighten tests" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Request changes" })[1]);

    await waitFor(() => {
      expect(mutateCreateCommentAsync).toHaveBeenCalledWith({
        id: "detail-done",
        input: expect.objectContaining({
          message: "Need to rework implementation details and tighten tests",
        }),
      });
      expect(mutateTaskEventAsync).toHaveBeenCalledWith({
        id: "detail-done",
        event: "request_changes",
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("should trigger start_ai event from backlog action when plan file does not exist", async () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-backlog" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Start AI"));
    await waitFor(() => {
      expect(mockGetTaskPlanFileStatus).toHaveBeenCalledWith("detail-backlog");
      expect(mutateTaskEvent).toHaveBeenCalledWith({
        id: "detail-backlog",
        event: "start_ai",
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("should show confirmation before start_ai when plan file already exists and allow overwrite", async () => {
    const onClose = vi.fn();
    mockGetTaskPlanFileStatus.mockResolvedValueOnce({
      exists: true,
      path: "/tmp/project/.ai-factory/PLAN.md",
    });

    render(<TaskDetail taskId="detail-backlog" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Start AI"));
    await waitFor(() => {
      expect(screen.getByText("Plan file already exists")).toBeDefined();
    });
    expect(mutateTaskEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Overwrite & Re-plan" }));
    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-backlog",
      event: "start_ai",
      deletePlanFile: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should accept existing plan when plan file already exists", async () => {
    const onClose = vi.fn();
    mockGetTaskPlanFileStatus.mockResolvedValueOnce({
      exists: true,
      path: "/tmp/project/.ai-factory/PLAN.md",
    });

    render(<TaskDetail taskId="detail-backlog" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Start AI"));
    await waitFor(() => {
      expect(screen.getByText("Plan file already exists")).toBeDefined();
    });
    expect(mutateTaskEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use Existing Plan" }));
    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-backlog",
      event: "accept_existing_plan",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should cancel start_ai when user cancels overwrite confirmation", async () => {
    const onClose = vi.fn();
    mockGetTaskPlanFileStatus.mockResolvedValueOnce({
      exists: true,
      path: "/tmp/project/.ai-factory/PLAN.md",
    });

    render(<TaskDetail taskId="detail-backlog" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Start AI"));
    await waitFor(() => {
      expect(screen.getByText("Plan file already exists")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutateTaskEvent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should trigger retry_from_blocked event from blocked action", () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-blocked" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Retry"));
    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-blocked",
      event: "retry_from_blocked",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should trigger start_implementation for manual plan_ready", () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={onClose} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Start implementation"));
    expect(mutateTaskEvent).toHaveBeenCalledWith({
      id: "detail-plan-ready-manual",
      event: "start_implementation",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("should render request replanning action for manual plan_ready", () => {
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText("Request replanning")).toBeDefined();
  });

  it("should render fast fix action for manual plan_ready", () => {
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText("Fast fix")).toBeDefined();
  });

  it("should submit replanning request and move task to planning", async () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={onClose} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Request replanning"));
    fireEvent.change(
      screen.getByPlaceholderText("Describe what needs to be changed in the plan..."),
      {
        target: { value: "Need more concrete API milestones" },
      },
    );
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mutateCreateCommentAsync).toHaveBeenCalledWith({
        id: "detail-plan-ready-manual",
        input: expect.objectContaining({
          message: "Need more concrete API milestones",
        }),
      });
      expect(mutateTaskEventAsync).toHaveBeenCalledWith({
        id: "detail-plan-ready-manual",
        event: "request_replanning",
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("should open and cancel replanning modal", () => {
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Request replanning"));
    expect(screen.getByText("Request Replanning")).toBeDefined();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Request Replanning")).toBeNull();
  });

  it("should submit fast fix request without moving status", async () => {
    const onClose = vi.fn();
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={onClose} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Fast fix"));
    fireEvent.change(screen.getByPlaceholderText("Describe the quick plan fix..."), {
      target: { value: "Add one extra QA step at the end" },
    });
    fireEvent.click(screen.getByText("Apply fast fix"));

    await waitFor(() => {
      expect(mutateCreateCommentAsync).toHaveBeenCalledWith({
        id: "detail-plan-ready-manual",
        input: expect.objectContaining({
          message: "Add one extra QA step at the end",
        }),
      });
      expect(mutateTaskEventAsync).toHaveBeenCalledWith({
        id: "detail-plan-ready-manual",
        event: "fast_fix",
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    expect(screen.queryByText("Fast Fix")).toBeNull();
  });

  it("should render review comments in review tab", () => {
    render(<TaskDetail taskId="detail-review" onClose={vi.fn()} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByText("Looks good after minor cleanup")).toBeDefined();
  });

  it("should open review tab by default for review status task", () => {
    render(<TaskDetail taskId="detail-review" onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByText("Review Comments")).toBeDefined();
    expect(screen.queryByText("Implementation Log")).toBeNull();
    expect(screen.getByText("Looks good after minor cleanup")).toBeDefined();
  });

  it("should upload task attachment and call update mutation", async () => {
    render(<TaskDetail taskId="detail-1" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Show attachments (0)"));
    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    const file = {
      name: "new.txt",
      type: "text/plain",
      size: 8,
      text: vi.fn().mockResolvedValue("new file"),
    } as unknown as File;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mutateUpdateTask).toHaveBeenCalledWith({
        id: "detail-1",
        input: {
          attachments: [
            {
              name: "new.txt",
              mimeType: "text/plain",
              size: 8,
              content: "new file",
            },
          ],
        },
      });
    });
  });

  it("should remove task attachment", () => {
    render(<TaskDetail taskId="detail-with-attachment" onClose={vi.fn()} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Show attachments (1)"));
    fireEvent.click(screen.getByLabelText("Remove old.txt"));

    expect(mutateUpdateTask).toHaveBeenCalledWith({
      id: "detail-with-attachment",
      input: {
        attachments: [],
      },
    });
  });

  it("should delete task after confirmation", () => {
    const onClose = vi.fn();
    mutateDeleteTask.mockImplementationOnce((_id: string, options: { onSuccess?: () => void }) => {
      options.onSuccess?.();
    });

    render(<TaskDetail taskId="detail-1" onClose={onClose} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Delete task"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(mutateDeleteTask).toHaveBeenCalledWith("detail-1", expect.any(Object));
    expect(onClose).toHaveBeenCalled();
  });

  it("should include uploaded text attachment in replanning request", async () => {
    render(<TaskDetail taskId="detail-plan-ready-manual" onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByText("Request replanning"));
    fireEvent.change(
      screen.getByPlaceholderText("Describe what needs to be changed in the plan..."),
      {
        target: { value: "Please split backend and frontend tasks" },
      },
    );

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[fileInputs.length - 1] as HTMLInputElement;
    const file = {
      name: "notes.md",
      type: "text/markdown",
      size: 11,
      text: vi.fn().mockResolvedValue("line1\nline2"),
    } as unknown as File;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(mutateCreateCommentAsync).toHaveBeenCalledWith({
        id: "detail-plan-ready-manual",
        input: {
          message: "Please split backend and frontend tasks",
          attachments: [
            {
              name: "notes.md",
              mimeType: "text/markdown",
              size: 11,
              content: "line1\nline2",
            },
          ],
        },
      });
    });
  });
});
