import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthorBadge } from "@/components/ui/author-badge";

describe("AuthorBadge", () => {
  it('renders "User" for human author', () => {
    render(<AuthorBadge author="human" />);
    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it('renders "Agent" for agent author', () => {
    render(<AuthorBadge author="agent" />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("renders User icon for human", () => {
    const { container } = render(<AuthorBadge author="human" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders Bot icon for agent", () => {
    const { container } = render(<AuthorBadge author="agent" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("uses custom label override", () => {
    render(<AuthorBadge author="human" label="Admin" />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByText("User")).toBeNull();
  });

  it("applies text-blue-400 for human", () => {
    const { container } = render(<AuthorBadge author="human" />);
    expect(container.firstElementChild!.className).toContain("text-blue-400");
  });

  it("applies text-agent for agent", () => {
    const { container } = render(<AuthorBadge author="agent" />);
    expect(container.firstElementChild!.className).toContain("text-agent");
  });
});
