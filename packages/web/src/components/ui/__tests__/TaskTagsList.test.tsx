import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskTagsList } from "../task-tags-list";

describe("TaskTagsList", () => {
  it("returns null when no tags and no roadmapAlias", () => {
    const { container } = render(<TaskTagsList />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null for empty tags array", () => {
    const { container } = render(<TaskTagsList tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders roadmapAlias badge", () => {
    render(<TaskTagsList roadmapAlias="v2.0" />);
    expect(screen.getByText("v2.0")).toBeInTheDocument();
  });

  it("renders tag badges", () => {
    render(<TaskTagsList tags={["frontend", "urgent"]} />);
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(screen.getByText("urgent")).toBeInTheDocument();
  });

  it("filters out rm: prefixed tags and roadmap tag", () => {
    render(<TaskTagsList tags={["roadmap", "rm:v1.0", "feature"]} />);
    expect(screen.queryByText("roadmap")).not.toBeInTheDocument();
    expect(screen.queryByText("rm:v1.0")).not.toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
  });

  it("applies compact styles", () => {
    render(<TaskTagsList tags={["bug"]} isCompact />);
    const badge = screen.getByText("bug");
    expect(badge).toHaveClass("text-[9px]");
  });

  it("applies comfortable styles by default", () => {
    render(<TaskTagsList tags={["bug"]} />);
    const badge = screen.getByText("bug");
    expect(badge).toHaveClass("text-[10px]");
  });

  it("renders both roadmapAlias and tags", () => {
    render(<TaskTagsList tags={["api"]} roadmapAlias="v3.0" />);
    expect(screen.getByText("v3.0")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
  });

  it("merges className", () => {
    const { container } = render(<TaskTagsList tags={["x"]} className="custom" />);
    expect(container.firstChild).toHaveClass("custom");
  });
});
