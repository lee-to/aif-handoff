import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api";

const handoffState = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    session: {
      participantsModeEnabled: true,
      authenticated: true,
      participant: { id: "admin-1", displayName: "Admin", role: "admin", active: true },
    },
  }),
}));

vi.mock("@/hooks/useParticipants", () => ({
  useParticipants: () => ({
    data: [
      { id: "admin-1", displayName: "Admin", role: "admin", active: true },
      { id: "participant-1", displayName: "Alice", role: "member", active: true },
    ],
  }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useHandoffTask: () => handoffState,
}));

const { HandoffDialog, TaskOwnershipSummary } = await import("@/components/task/TaskOwnership");

const task = {
  id: "task-1",
  executionOwner: "ai" as const,
  ownershipRevision: 4,
  assignees: [],
  status: "implementing" as const,
  autoMode: true,
};

describe("TaskOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handoffState.isPending = false;
    handoffState.isError = false;
    handoffState.error = null;
  });

  it("shows inactive historical assignees", () => {
    render(
      <TaskOwnershipSummary
        executionOwner="human"
        assignees={[
          {
            participantId: "participant-1",
            displayName: "Alice",
            role: "member",
            active: false,
          },
        ]}
      />,
    );

    expect(screen.getByText("Human owner")).toBeDefined();
    expect(screen.getByText("Alice (inactive)")).toBeDefined();
  });

  it("submits revision-safe multi-assignee handoffs", () => {
    render(<HandoffDialog task={task} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Human"));
    fireEvent.click(screen.getByText("Alice"));
    fireEvent.click(screen.getByRole("button", { name: "Save ownership" }));

    expect(handoffState.mutate).toHaveBeenCalledWith(
      {
        id: "task-1",
        input: {
          executionOwner: "human",
          assigneeIds: ["participant-1"],
          expectedOwnershipRevision: 4,
          expectedExecutionOwner: "ai",
          expectedStatus: "implementing",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("surfaces structured ownership conflicts", () => {
    handoffState.isError = true;
    handoffState.error = new ApiError("conflict", 409, { code: "task_locked" });

    render(<HandoffDialog task={task} open onOpenChange={vi.fn()} />);

    expect(screen.getByText(/AI is currently working on this task/)).toBeDefined();
  });
});
