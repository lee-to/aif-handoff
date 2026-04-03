import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimestampLabel } from "@/components/ui/timestamp-label";

describe("TimestampLabel", () => {
  it("renders children", () => {
    render(<TimestampLabel>2m ago</TimestampLabel>);
    expect(screen.getByText("2m ago")).toBeInTheDocument();
  });

  it("applies monospace font class", () => {
    render(<TimestampLabel>abc-123</TimestampLabel>);
    const el = screen.getByText("abc-123");
    expect(el.className).toContain("font-mono");
  });

  it("merges custom className", () => {
    render(<TimestampLabel className="text-red-500">ts</TimestampLabel>);
    const el = screen.getByText("ts");
    expect(el.className).toContain("text-red-500");
  });
});
