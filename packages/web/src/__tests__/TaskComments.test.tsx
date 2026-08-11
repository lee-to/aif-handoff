import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useTaskCommentsMock = vi.fn();

vi.mock("@/hooks/useTasks", () => ({
  useTaskComments: (...args: unknown[]) => useTaskCommentsMock(...args),
}));

const { TaskComments } = await import("@/components/task/TaskComments");

describe("TaskComments", () => {
  it("shows loading state", () => {
    useTaskCommentsMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("Loading comments...")).toBeDefined();
  });

  it("shows empty state", () => {
    useTaskCommentsMock.mockReturnValue({ data: [], isLoading: false });
    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("No comments yet")).toBeDefined();
  });

  it("renders comments with attachments", () => {
    useTaskCommentsMock.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: "c-1",
          taskId: "t-1",
          author: "human",
          participantId: "participant-1",
          participant: {
            id: "participant-1",
            displayName: "Alice",
            role: "member",
            active: false,
          },
          message: "Please adjust the architecture section.",
          createdAt: "2026-01-01T10:00:00.000Z",
          attachments: [
            {
              name: "notes.md",
              mimeType: "text/markdown",
              size: 120,
              content: "# note",
            },
          ],
        },
      ],
    });

    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("Please adjust the architecture section.")).toBeDefined();
    expect(screen.getByText("Alice (inactive)")).toBeDefined();
    expect(screen.getByText("Attachments")).toBeDefined();
    expect(screen.getByText(/notes\.md/)).toBeDefined();
  });
});
