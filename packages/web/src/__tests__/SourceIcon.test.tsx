import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SourceIcon } from "@/components/ui/source-icon";

describe("SourceIcon", () => {
  it("renders Terminal icon for cli", () => {
    const { container } = render(<SourceIcon source="cli" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg!.className.baseVal || svg!.getAttribute("class")).toContain("h-3.5");
  });

  it("renders Bot icon for agent", () => {
    const { container } = render(<SourceIcon source="agent" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders MessageSquare icon for web", () => {
    const { container } = render(<SourceIcon source="web" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders fallback Circle icon for unknown source", () => {
    const { container } = render(<SourceIcon source="email" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<SourceIcon source="cli" className="text-red-500" />);
    const svg = container.querySelector("svg");
    expect(svg!.getAttribute("class")).toContain("text-red-500");
  });
});
