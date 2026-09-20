import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskDescription } from "@/components/task/TaskDescription";

describe("TaskDescription", () => {
  it("renders placeholder when description is empty", () => {
    render(<TaskDescription description="" onSave={vi.fn()} />);
    expect(screen.getByText("No description")).toBeDefined();
  });

  it("allows editing and saving description", () => {
    const onSave = vi.fn();
    render(<TaskDescription description="Old text" onSave={onSave} />);

    fireEvent.click(screen.getByRole("button"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Updated text" } });
    fireEvent.click(screen.getByText("Save"));

    expect(onSave).toHaveBeenCalledWith("Updated text");
  });

  it("cancels editing and restores original value", () => {
    const onSave = vi.fn();
    render(<TaskDescription description="Stable text" onSave={onSave} />);

    fireEvent.click(screen.getByRole("button"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Temporary" } });
    fireEvent.click(screen.getByText("Cancel"));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText("Stable text").length).toBeGreaterThan(0);
  });

  it("keeps synchronized descriptions read-only", () => {
    render(<TaskDescription description="GitHub source" onSave={vi.fn()} readOnly />);

    expect(screen.getByText("GitHub source")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  });
});
