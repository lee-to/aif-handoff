import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot } from "@/components/ui/status-dot";

describe("StatusDot", () => {
  it("renders with default size", () => {
    const { container } = render(<StatusDot status="active" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain("h-2");
    expect(dot.className).toContain("w-2");
  });

  it("renders with sm size", () => {
    const { container } = render(<StatusDot status="active" size="sm" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain("h-1.5");
    expect(dot.className).toContain("w-1.5");
  });

  it("applies status-based color via inline style", () => {
    const { container } = render(<StatusDot status="running" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.style.backgroundColor).toBe(
      "var(--color-status-running, var(--color-muted-foreground))",
    );
  });

  it("merges custom className", () => {
    const { container } = render(<StatusDot status="active" className="ml-2" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain("ml-2");
    expect(dot.className).toContain("rounded-full");
  });

  it("has rounded-full and shrink-0 base classes", () => {
    const { container } = render(<StatusDot status="idle" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("shrink-0");
  });
});
