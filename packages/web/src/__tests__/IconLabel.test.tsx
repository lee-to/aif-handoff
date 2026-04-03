import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IconLabel } from "@/components/ui/icon-label";

describe("IconLabel", () => {
  it("renders icon and text", () => {
    render(<IconLabel icon={<span data-testid="icon">I</span>}>Hello</IconLabel>);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("uses default gap", () => {
    const { container } = render(<IconLabel icon={<span>I</span>}>text</IconLabel>);
    expect(container.firstElementChild!.className).toContain("gap-1.5");
  });

  it("uses sm gap", () => {
    const { container } = render(
      <IconLabel icon={<span>I</span>} gap="sm">
        text
      </IconLabel>,
    );
    expect(container.firstElementChild!.className).toContain("gap-1");
    expect(container.firstElementChild!.className).not.toContain("gap-1.5");
  });

  it("merges custom className", () => {
    const { container } = render(
      <IconLabel icon={<span>I</span>} className="text-red-500">
        text
      </IconLabel>,
    );
    expect(container.firstElementChild!.className).toContain("text-red-500");
  });
});
