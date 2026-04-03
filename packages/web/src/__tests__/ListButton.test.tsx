import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { ListButton } from "@/components/ui/list-button";

describe("ListButton", () => {
  it("renders children", () => {
    render(<ListButton>Click me</ListButton>);
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<ListButton onClick={onClick}>Click me</ListButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies active state styling", () => {
    render(
      <ListButton active data-testid="btn">
        Item
      </ListButton>,
    );
    const el = screen.getByTestId("btn");
    expect(el.className).toContain("bg-accent/60");
  });

  it("does not apply active styling when inactive", () => {
    render(<ListButton data-testid="btn">Item</ListButton>);
    const el = screen.getByTestId("btn");
    expect(el.className).not.toContain("bg-accent/60");
  });

  it("merges custom className", () => {
    render(
      <ListButton className="extra" data-testid="btn">
        Item
      </ListButton>,
    );
    const el = screen.getByTestId("btn");
    expect(el.className).toContain("extra");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<ListButton ref={ref}>Item</ListButton>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
