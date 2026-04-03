import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyHint } from "@/components/ui/key-hint";

describe("KeyHint", () => {
  it("renders key labels", () => {
    render(<KeyHint keys={["Cmd", "K"]} />);
    const kbds = screen.getAllByRole("generic").filter((el) => el.tagName === "KBD");
    expect(kbds).toHaveLength(2);
    expect(kbds[0].textContent).toBe("Cmd");
    expect(kbds[1].textContent).toBe("K");
  });

  it("renders + separator between keys", () => {
    const { container } = render(<KeyHint keys={["Ctrl", "Shift", "P"]} />);
    const separators = container.querySelectorAll("span.text-\\[10px\\]");
    expect(separators).toHaveLength(2);
    separators.forEach((sep) => expect(sep.textContent).toBe("+"));
  });

  it("single key works without separator", () => {
    const { container } = render(<KeyHint keys={["Esc"]} />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds).toHaveLength(1);
    expect(kbds[0].textContent).toBe("Esc");
    const separators = container.querySelectorAll("span.text-\\[10px\\]");
    expect(separators).toHaveLength(0);
  });

  it("merges className", () => {
    const { container } = render(<KeyHint keys={["A"]} className="ml-2" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("ml-2");
    expect(wrapper.className).toContain("inline-flex");
  });
});
