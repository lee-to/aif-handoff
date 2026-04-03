import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TableHeaderCell } from "../table-header-cell";

function renderInTable(ui: React.ReactElement) {
  return render(
    <table>
      <thead>
        <tr>{ui}</tr>
      </thead>
    </table>,
  );
}

describe("TableHeaderCell", () => {
  it("renders children", () => {
    renderInTable(<TableHeaderCell>Task</TableHeaderCell>);
    expect(screen.getByText("Task")).toBeInTheDocument();
  });

  it("has uppercase tracking styles", () => {
    renderInTable(<TableHeaderCell>Status</TableHeaderCell>);
    const th = screen.getByText("Status");
    expect(th).toHaveClass("uppercase");
    expect(th).toHaveClass("tracking-[0.16em]");
  });

  it("uses compact styles when isCompact", () => {
    renderInTable(<TableHeaderCell isCompact>Name</TableHeaderCell>);
    const th = screen.getByText("Name");
    expect(th).toHaveClass("py-1.5");
    expect(th).toHaveClass("text-[10px]");
  });

  it("uses comfortable styles by default", () => {
    renderInTable(<TableHeaderCell>Name</TableHeaderCell>);
    const th = screen.getByText("Name");
    expect(th).toHaveClass("py-2");
    expect(th).toHaveClass("text-[11px]");
  });

  it("merges className", () => {
    renderInTable(<TableHeaderCell className="w-40">Col</TableHeaderCell>);
    expect(screen.getByText("Col")).toHaveClass("w-40");
  });

  it("passes through HTML attributes", () => {
    renderInTable(<TableHeaderCell colSpan={2}>Merged</TableHeaderCell>);
    expect(screen.getByText("Merged")).toHaveAttribute("colspan", "2");
  });
});
