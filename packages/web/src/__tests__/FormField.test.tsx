import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormField } from "@/components/ui/form-field";

describe("FormField", () => {
  it("renders label text", () => {
    render(
      <FormField label="Email">
        <input />
      </FormField>,
    );

    expect(screen.getByText("Email")).toBeInTheDocument();
  });

  it("renders children (input slot)", () => {
    render(
      <FormField label="Name">
        <input data-testid="name-input" />
      </FormField>,
    );

    expect(screen.getByTestId("name-input")).toBeInTheDocument();
  });

  it("shows error message when error prop is provided", () => {
    render(
      <FormField label="Email" error="Email is required">
        <input />
      </FormField>,
    );

    expect(screen.getByText("Email is required")).toBeInTheDocument();
  });

  it("does not show error message when no error prop", () => {
    render(
      <FormField label="Email">
        <input />
      </FormField>,
    );

    expect(screen.queryByText("Email is required")).not.toBeInTheDocument();
  });

  it("shows required asterisk when required is true", () => {
    render(
      <FormField label="Email" required>
        <input />
      </FormField>,
    );

    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("does not show asterisk when not required", () => {
    render(
      <FormField label="Email">
        <input />
      </FormField>,
    );

    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("htmlFor connects label to input", () => {
    render(
      <FormField label="Email" htmlFor="email-field">
        <input id="email-field" />
      </FormField>,
    );

    const label = screen.getByText("Email");
    expect(label).toHaveAttribute("for", "email-field");
  });

  it("merges className onto wrapper", () => {
    const { container } = render(
      <FormField label="Email" className="custom-class">
        <input />
      </FormField>,
    );

    expect(container.firstChild).toHaveClass("custom-class");
    expect(container.firstChild).toHaveClass("space-y-1.5");
  });
});
