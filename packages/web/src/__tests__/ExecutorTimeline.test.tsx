import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const historyMock = vi.fn();

vi.mock("@/hooks/useTasks", () => ({
  useTaskExecutorHistory: (...args: unknown[]) => historyMock(...args),
}));

const { ExecutorTimeline } = await import("@/components/task/ExecutorTimeline");

describe("ExecutorTimeline", () => {
  it("renders immutable executor snapshots in chronological order", () => {
    historyMock.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: "history-1",
          taskId: "task-1",
          taskTitleSnapshot: "Participant task",
          ownershipRevision: 0,
          executionOwner: "ai",
          assignees: [],
          statusSnapshot: "planning",
          actor: { kind: "system", id: null, displayNameSnapshot: "System" },
          reason: null,
          createdAt: "2026-07-01T10:00:00.000Z",
        },
        {
          id: "history-2",
          taskId: "task-1",
          taskTitleSnapshot: "Participant task",
          ownershipRevision: 1,
          executionOwner: "human",
          assignees: [
            {
              participantId: "participant-1",
              displayName: "Alice",
              role: "member",
              active: false,
            },
          ],
          statusSnapshot: "implementing",
          actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
          reason: "Manual implementation requested",
          createdAt: "2026-07-01T11:00:00.000Z",
        },
      ],
    });

    render(<ExecutorTimeline taskId="task-1" />);

    expect(screen.getByText("AI owner")).toBeDefined();
    expect(screen.getByText("Human owner")).toBeDefined();
    expect(screen.getByText("Alice (inactive)")).toBeDefined();
    expect(screen.getByText("Changed by Admin")).toBeDefined();
    expect(screen.getByText("Manual implementation requested")).toBeDefined();
  });
});
