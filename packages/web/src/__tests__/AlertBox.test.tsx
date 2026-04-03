import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertBox } from "@/components/ui/alert-box";

describe("AlertBox", () => {
  it("renders success variant with correct classes", () => {
    const { container } = render(<AlertBox variant="success">Done</AlertBox>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-success/30");
    expect(el.className).toContain("bg-success/10");
    expect(el.className).toContain("text-success");
  });

  it("renders error variant with correct classes", () => {
    const { container } = render(<AlertBox variant="error">Failed</AlertBox>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-destructive/30");
    expect(el.className).toContain("bg-destructive/10");
    expect(el.className).toContain("text-destructive");
  });

  it("renders warning variant with correct classes", () => {
    const { container } = render(<AlertBox variant="warning">Caution</AlertBox>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-warning/30");
    expect(el.className).toContain("bg-warning/10");
    expect(el.className).toContain("text-warning");
  });

  it("renders info variant with correct classes", () => {
    const { container } = render(<AlertBox variant="info">Note</AlertBox>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-info/30");
    expect(el.className).toContain("bg-info/10");
    expect(el.className).toContain("text-info");
  });

  it("renders icon slot", () => {
    render(
      <AlertBox variant="success" icon={<span data-testid="icon">!</span>}>
        With icon
      </AlertBox>,
    );
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByTestId("icon").textContent).toBe("!");
  });

  it("renders children", () => {
    render(<AlertBox variant="info">Hello world</AlertBox>);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("merges custom className", () => {
    const { container } = render(
      <AlertBox variant="success" className="mt-4 text-xs">
        Test
      </AlertBox>,
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("mt-4");
    expect(el.className).toContain("text-xs");
    expect(el.className).toContain("border-success/30");
  });

  it("has base classes on all variants", () => {
    const { container } = render(<AlertBox variant="warning">Test</AlertBox>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border");
    expect(el.className).toContain("px-3");
    expect(el.className).toContain("py-2");
    expect(el.className).toContain("rounded-none");
  });
});
