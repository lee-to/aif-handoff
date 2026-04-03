import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { Card } from "@/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("applies default variant classes", () => {
    render(<Card data-testid="card">content</Card>);
    const el = screen.getByTestId("card");
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("bg-card");
  });

  it("applies muted variant classes", () => {
    render(
      <Card variant="muted" data-testid="card">
        content
      </Card>,
    );
    const el = screen.getByTestId("card");
    expect(el.className).toContain("bg-card/65");
  });

  it("applies ghost variant classes", () => {
    render(
      <Card variant="ghost" data-testid="card">
        content
      </Card>,
    );
    const el = screen.getByTestId("card");
    expect(el.className).toContain("border-transparent");
    expect(el.className).toContain("bg-transparent");
  });

  it("merges custom className", () => {
    render(
      <Card className="custom-class" data-testid="card">
        content
      </Card>,
    );
    const el = screen.getByTestId("card");
    expect(el.className).toContain("custom-class");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>content</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
