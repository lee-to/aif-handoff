import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders with default variant and size", () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain("h-9");
  });

  it("renders xs size variant", () => {
    render(<Button size="xs">Tiny</Button>);
    const btn = screen.getByRole("button", { name: "Tiny" });
    expect(btn.className).toContain("h-6");
    expect(btn.className).toContain("px-2");
    expect(btn.className).toContain("text-[10px]");
  });

  it("xs size does not include default size classes", () => {
    render(<Button size="xs">Tiny</Button>);
    const btn = screen.getByRole("button", { name: "Tiny" });
    expect(btn.className).not.toContain("h-9");
    expect(btn.className).not.toContain("px-4");
  });

  it("merges className with xs size", () => {
    render(
      <Button size="xs" className="ml-2">
        Tiny
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Tiny" });
    expect(btn.className).toContain("ml-2");
    expect(btn.className).toContain("h-6");
  });
});
