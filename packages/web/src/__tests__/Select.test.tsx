import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "@/components/ui/select";

describe("Select", () => {
  it("portals options outside overflow containers", () => {
    render(
      <div data-testid="scroll-container" className="overflow-x-auto">
        <Select
          value="member"
          options={[
            { value: "admin", label: "Admin" },
            { value: "member", label: "Member" },
          ]}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Member" }));

    const listbox = screen.getByRole("listbox");
    expect(screen.getByTestId("scroll-container")).not.toContainElement(listbox);
    expect(listbox).toHaveStyle({ position: "fixed" });
  });
});
