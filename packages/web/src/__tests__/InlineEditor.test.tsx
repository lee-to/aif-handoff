import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InlineEditor } from "@/components/ui/inline-editor";

describe("InlineEditor", () => {
  it("starts in view mode (renderView called)", () => {
    render(
      <InlineEditor
        value="hello"
        onSave={() => {}}
        renderView={({ value }) => <span data-testid="view">{value}</span>}
        renderEdit={() => <input data-testid="edit" />}
      />,
    );

    expect(screen.getByTestId("view")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByTestId("edit")).not.toBeInTheDocument();
  });

  it("clicking edit enters edit mode (renderEdit called)", () => {
    render(
      <InlineEditor
        value="hello"
        onSave={() => {}}
        renderView={({ onEdit }) => (
          <button data-testid="edit-btn" onClick={onEdit}>
            Edit
          </button>
        )}
        renderEdit={({ draft }) => <input data-testid="edit" defaultValue={draft} />}
      />,
    );

    fireEvent.click(screen.getByTestId("edit-btn"));

    expect(screen.getByTestId("edit")).toBeInTheDocument();
    expect(screen.queryByTestId("edit-btn")).not.toBeInTheDocument();
  });

  it("save calls onSave with draft value", () => {
    const onSave = vi.fn();

    render(
      <InlineEditor
        value="hello"
        onSave={onSave}
        renderView={({ onEdit }) => (
          <button data-testid="edit-btn" onClick={onEdit}>
            Edit
          </button>
        )}
        renderEdit={({ draft, onChange, onSave: doSave }) => (
          <div>
            <input
              data-testid="edit-input"
              value={draft}
              onChange={(e) => onChange(e.target.value)}
            />
            <button data-testid="save-btn" onClick={doSave}>
              Save
            </button>
          </div>
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("edit-btn"));
    fireEvent.change(screen.getByTestId("edit-input"), { target: { value: "world" } });
    fireEvent.click(screen.getByTestId("save-btn"));

    expect(onSave).toHaveBeenCalledWith("world");
    // Returns to view mode after save
    expect(screen.getByTestId("edit-btn")).toBeInTheDocument();
  });

  it("cancel resets to view mode", () => {
    render(
      <InlineEditor
        value="hello"
        onSave={() => {}}
        renderView={({ value, onEdit }) => (
          <button data-testid="edit-btn" onClick={onEdit}>
            {value}
          </button>
        )}
        renderEdit={({ onCancel }) => (
          <button data-testid="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("edit-btn"));
    expect(screen.queryByTestId("edit-btn")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cancel-btn"));
    expect(screen.getByTestId("edit-btn")).toBeInTheDocument();
  });

  it("draft changes are tracked", () => {
    const onSave = vi.fn();

    render(
      <InlineEditor
        value="initial"
        onSave={onSave}
        renderView={({ onEdit }) => (
          <button data-testid="edit-btn" onClick={onEdit}>
            Edit
          </button>
        )}
        renderEdit={({ draft, onChange, onSave: doSave }) => (
          <div>
            <input
              data-testid="edit-input"
              value={draft}
              onChange={(e) => onChange(e.target.value)}
            />
            <button data-testid="save-btn" onClick={doSave}>
              Save
            </button>
          </div>
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("edit-btn"));

    // Draft starts with initial value
    expect(screen.getByTestId("edit-input")).toHaveValue("initial");

    // Update draft multiple times
    fireEvent.change(screen.getByTestId("edit-input"), { target: { value: "step1" } });
    expect(screen.getByTestId("edit-input")).toHaveValue("step1");

    fireEvent.change(screen.getByTestId("edit-input"), { target: { value: "step2" } });
    expect(screen.getByTestId("edit-input")).toHaveValue("step2");

    fireEvent.click(screen.getByTestId("save-btn"));
    expect(onSave).toHaveBeenCalledWith("step2");
  });
});
