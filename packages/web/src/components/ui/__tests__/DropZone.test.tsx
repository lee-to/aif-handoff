import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "../drop-zone";

describe("DropZone", () => {
  it("renders default label", () => {
    render(<DropZone onFiles={vi.fn()} />);
    expect(screen.getByText(/drag files here/i)).toBeInTheDocument();
  });

  it("renders custom label", () => {
    render(<DropZone onFiles={vi.fn()} label="Drop here" />);
    expect(screen.getByText("Drop here")).toBeInTheDocument();
  });

  it("renders children when provided", () => {
    render(
      <DropZone onFiles={vi.fn()}>
        <span data-testid="custom">Custom content</span>
      </DropZone>,
    );
    expect(screen.getByTestId("custom")).toBeInTheDocument();
  });

  it("calls onFiles when files are dropped", () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("region");
    const file = new File(["data"], "test.txt", { type: "text/plain" });
    const dropEvent = new Event("drop", { bubbles: true }) as unknown as DragEvent & {
      dataTransfer: { files: FileList };
    };
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: { length: 1, 0: file, item: () => file } },
    });
    zone.dispatchEvent(dropEvent);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("does not call onFiles on empty drop", () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole("region");
    const dropEvent = new Event("drop", { bubbles: true }) as unknown as DragEvent & {
      dataTransfer: { files: FileList };
    };
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: { length: 0 } },
    });
    zone.dispatchEvent(dropEvent);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("applies hover class on dragOver and removes on dragLeave", () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByRole("region");
    fireEvent.dragOver(zone, { preventDefault: vi.fn() });
    expect(zone.className).toContain("border-primary/60");
    fireEvent.dragLeave(zone);
    expect(zone.className).toContain("border-border");
  });

  it("has accessible aria-label", () => {
    render(<DropZone onFiles={vi.fn()} label="Upload area" />);
    expect(screen.getByLabelText("Upload area")).toBeInTheDocument();
  });

  it("merges className", () => {
    render(<DropZone onFiles={vi.fn()} className="custom" />);
    expect(screen.getByRole("region")).toHaveClass("custom");
  });
});
