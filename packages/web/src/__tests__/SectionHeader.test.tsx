import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeader } from "@/components/ui/section-header";

describe("SectionHeader", () => {
  it("renders title text", () => {
    render(<SectionHeader>Tasks</SectionHeader>);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("renders action slot", () => {
    render(
      <SectionHeader action={<button data-testid="action-btn">Add</button>}>Tasks</SectionHeader>,
    );
    expect(screen.getByTestId("action-btn")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("action slot is right-aligned with flex justify-between", () => {
    const { container } = render(
      <SectionHeader action={<button>Add</button>}>Tasks</SectionHeader>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("justify-between");
  });

  it("merges className", () => {
    const { container } = render(<SectionHeader className="mb-4">Title</SectionHeader>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("mb-4");
    expect(el.className).toContain("uppercase");
  });

  it("renders without action", () => {
    const { container } = render(<SectionHeader>Simple</SectionHeader>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("H3");
    expect(el.className).not.toContain("justify-between");
  });
});
