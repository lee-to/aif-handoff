import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "@/components/ui/progress-bar";

describe("ProgressBar", () => {
  it("renders outer bar with correct base classes", () => {
    const { container } = render(<ProgressBar value={50} />);
    const outer = container.firstElementChild!;
    expect(outer.className).toContain("h-1");
    expect(outer.className).toContain("w-full");
    expect(outer.className).toContain("overflow-hidden");
    expect(outer.className).toContain("bg-secondary");
    expect(outer.className).toContain("border");
    expect(outer.className).toContain("border-border");
  });

  it("sets inner bar width from value prop", () => {
    const { container } = render(<ProgressBar value={42} />);
    const inner = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("42%");
  });

  it("handles 0% edge case", () => {
    const { container } = render(<ProgressBar value={0} />);
    const inner = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("0%");
  });

  it("handles 100% edge case", () => {
    const { container } = render(<ProgressBar value={100} />);
    const inner = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(inner.style.width).toBe("100%");
  });

  it("merges custom className on outer bar", () => {
    const { container } = render(<ProgressBar value={50} className="mt-4" />);
    const outer = container.firstElementChild!;
    expect(outer.className).toContain("mt-4");
    expect(outer.className).toContain("h-1");
  });

  it("inner bar has primary bg and transition", () => {
    const { container } = render(<ProgressBar value={50} />);
    const inner = container.firstElementChild!.firstElementChild!;
    expect(inner.className).toContain("bg-primary");
    expect(inner.className).toContain("transition-all");
  });
});
