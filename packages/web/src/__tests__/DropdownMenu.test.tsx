import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

function DropdownHarness({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <div data-testid="state">{open ? "open" : "closed"}</div>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger>
          <span>Open menu</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="item-edit">Edit</DropdownMenuItem>
          <DropdownMenuItem data-testid="item-delete" destructive>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

describe("DropdownMenu", () => {
  it("renders trigger", () => {
    render(<DropdownHarness />);
    expect(screen.getByText("Open menu")).toBeTruthy();
  });

  it("opens on click", () => {
    render(<DropdownHarness />);
    expect(screen.getByTestId("state").textContent).toBe("closed");
    fireEvent.click(screen.getByText("Open menu"));
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("keeps an as-child trigger measurable for portal positioning", () => {
    function AsChildHarness() {
      const [open, setOpen] = useState(false);
      return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button">Open child menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>Content</DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<AsChildHarness />);
    const wrapper = screen.getByRole("button", { name: "Open child menu" }).parentElement;

    expect(wrapper?.className).toContain("inline-flex");
    expect(wrapper?.className).not.toContain("contents");
  });

  it("shows content when open", () => {
    render(<DropdownHarness defaultOpen />);
    expect(screen.getByTestId("item-edit")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("closes on ESC", () => {
    render(<DropdownHarness defaultOpen />);
    expect(screen.getByTestId("state").textContent).toBe("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("closes on outside click", () => {
    render(<DropdownHarness defaultOpen />);
    expect(screen.getByTestId("state").textContent).toBe("open");
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("closes on item click", () => {
    render(<DropdownHarness defaultOpen />);
    expect(screen.getByTestId("state").textContent).toBe("open");
    fireEvent.click(screen.getByTestId("item-edit"));
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("applies destructive variant styles", () => {
    render(<DropdownHarness defaultOpen />);
    const deleteItem = screen.getByTestId("item-delete");
    expect(deleteItem.className).toContain("text-destructive");
    expect(deleteItem.className).toContain("hover:bg-destructive/10");
  });

  it("merges className on content", () => {
    const [open, setOpen] = [true, vi.fn()];

    function CustomHarness() {
      return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent className="custom-class">
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<CustomHarness />);
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("custom-class");
    expect(menu.className).toContain("border");
  });
});
