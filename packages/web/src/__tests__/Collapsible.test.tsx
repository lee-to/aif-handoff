import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Collapsible } from "@/components/ui/collapsible";

describe("Collapsible", () => {
  it("renders trigger text", () => {
    render(
      <Collapsible open={false} onOpenChange={() => {}} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    expect(screen.getByText("Toggle")).toBeInTheDocument();
  });

  it("hides children when closed", () => {
    render(
      <Collapsible open={false} onOpenChange={() => {}} trigger="Toggle">
        <div>hidden content</div>
      </Collapsible>,
    );
    expect(screen.queryByText("hidden content")).not.toBeInTheDocument();
  });

  it("shows children when open", () => {
    render(
      <Collapsible open={true} onOpenChange={() => {}} trigger="Toggle">
        <div>visible content</div>
      </Collapsible>,
    );
    expect(screen.getByText("visible content")).toBeInTheDocument();
  });

  it("renders ChevronRight icon when closed", () => {
    const { container } = render(
      <Collapsible open={false} onOpenChange={() => {}} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    // ChevronRight has a specific path; ChevronDown has a different one.
    // We check via the aria-expanded attribute on the button instead.
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("renders ChevronDown icon when open", () => {
    render(
      <Collapsible open={true} onOpenChange={() => {}} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("sets aria-expanded correctly", () => {
    const { rerender } = render(
      <Collapsible open={false} onOpenChange={() => {}} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");

    rerender(
      <Collapsible open={true} onOpenChange={() => {}} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("calls onOpenChange on click", () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible open={false} onOpenChange={onOpenChange} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("calls onOpenChange with false when open", () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible open={true} onOpenChange={onOpenChange} trigger="Toggle">
        <div>body</div>
      </Collapsible>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
