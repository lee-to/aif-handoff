import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskAttachments } from "@/components/task/TaskAttachments";
import type { TaskCommentAttachment } from "@aif/shared/browser";

const sampleAttachments: TaskCommentAttachment[] = [
  { name: "readme.md", mimeType: "text/markdown", size: 120, content: "# Hello" },
  { name: "logo.png", mimeType: "image/png", size: 5000, content: null },
];

describe("TaskAttachments", () => {
  it("should render collapsed by default showing count", () => {
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={sampleAttachments}
        onFilesSelected={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("Show attachments (2)")).toBeDefined();
    expect(screen.queryByText("readme.md")).toBeNull();
  });

  it("should expand and show attachment list on click", () => {
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={sampleAttachments}
        onFilesSelected={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (2)"));
    expect(screen.getByText("Hide attachments")).toBeDefined();
    expect(screen.getByText(/readme\.md/)).toBeDefined();
    expect(screen.getByText(/logo\.png/)).toBeDefined();
  });

  it("should show metadata-only badge for attachments without content", () => {
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={sampleAttachments}
        onFilesSelected={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (2)"));
    expect(screen.getByText("(metadata only)")).toBeDefined();
  });

  it("should show empty message when no attachments", () => {
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={[]}
        onFilesSelected={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (0)"));
    expect(screen.getByText("No files attached to this task.")).toBeDefined();
  });

  it("should call onRemove when Remove button is clicked", () => {
    const onRemove = vi.fn();
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={sampleAttachments}
        onFilesSelected={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (2)"));
    const removeButtons = screen.getAllByLabelText(/^Remove /);
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("should call onFilesSelected when file input changes", () => {
    const onFilesSelected = vi.fn();
    const { container } = render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={[]}
        onFilesSelected={onFilesSelected}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (0)"));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const mockFiles = [new File(["test"], "test.txt", { type: "text/plain" })];
    fireEvent.change(fileInput, { target: { files: mockFiles } });
    expect(onFilesSelected).toHaveBeenCalledWith(mockFiles);
  });

  it("should call onFilesSelected on drop", () => {
    const onFilesSelected = vi.fn();
    render(
      <TaskAttachments
        taskId="test-task-id"
        attachments={[]}
        onFilesSelected={onFilesSelected}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Show attachments (0)"));
    const dropZone = screen.getByText("Drag files here to attach");
    const mockFiles = [new File(["test"], "dropped.txt", { type: "text/plain" })];
    fireEvent.drop(dropZone, { dataTransfer: { files: mockFiles } });
    expect(onFilesSelected).toHaveBeenCalledWith(mockFiles);
  });
});
