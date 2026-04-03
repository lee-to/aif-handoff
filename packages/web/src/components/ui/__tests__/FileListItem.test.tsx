import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileListItem } from "../file-list-item";

function renderInList(ui: React.ReactElement) {
  return render(<ul>{ui}</ul>);
}

describe("FileListItem", () => {
  it("renders file name and mime type", () => {
    renderInList(<FileListItem name="test.txt" mimeType="text/plain" />);
    expect(screen.getByText(/test\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/text\/plain/)).toBeInTheDocument();
  });

  it("shows unknown when mimeType is missing", () => {
    renderInList(<FileListItem name="file.bin" />);
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
  });

  it("formats file size", () => {
    renderInList(<FileListItem name="img.png" size={2048} />);
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });

  it("shows metadata only indicator", () => {
    renderInList(<FileListItem name="doc.pdf" metadataOnly />);
    expect(screen.getByText(/metadata only/)).toBeInTheDocument();
  });

  it("renders download link when downloadUrl provided", () => {
    renderInList(<FileListItem name="file.zip" downloadUrl="/dl/file.zip" />);
    const link = screen.getByTitle("Download");
    expect(link).toHaveAttribute("href", "/dl/file.zip");
    expect(link).toHaveAttribute("download", "file.zip");
  });

  it("renders remove button and calls onRemove", () => {
    const onRemove = vi.fn();
    renderInList(<FileListItem name="old.txt" onRemove={onRemove} />);
    const btn = screen.getByLabelText("Remove old.txt");
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides download and remove when not provided", () => {
    renderInList(<FileListItem name="plain.txt" />);
    expect(screen.queryByTitle("Download")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove/)).not.toBeInTheDocument();
  });

  it("merges className", () => {
    const { container } = renderInList(<FileListItem name="x.txt" className="custom" />);
    expect(container.querySelector("li")).toHaveClass("custom");
  });
});
