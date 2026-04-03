import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormDialog } from "@/components/ui/form-dialog";

describe("FormDialog", () => {
  it("renders title", () => {
    render(
      <FormDialog
        open={true}
        onOpenChange={() => {}}
        title="Create Task"
        actions={<button>Submit</button>}
      >
        <div>form content</div>
      </FormDialog>,
    );

    expect(screen.getByText("Create Task")).toBeInTheDocument();
  });

  it("renders form content (children)", () => {
    render(
      <FormDialog
        open={true}
        onOpenChange={() => {}}
        title="Edit Task"
        actions={<button>Save</button>}
      >
        <div data-testid="form-body">fields here</div>
      </FormDialog>,
    );

    expect(screen.getByTestId("form-body")).toBeInTheDocument();
  });

  it("renders actions footer", () => {
    render(
      <FormDialog
        open={true}
        onOpenChange={() => {}}
        title="Confirm"
        actions={<button data-testid="submit-btn">Submit</button>}
      >
        <div>content</div>
      </FormDialog>,
    );

    expect(screen.getByTestId("submit-btn")).toBeInTheDocument();
  });

  it("shows error message when error prop is provided", () => {
    render(
      <FormDialog
        open={true}
        onOpenChange={() => {}}
        title="Create"
        error="Something went wrong"
        actions={<button>OK</button>}
      >
        <div>content</div>
      </FormDialog>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("does not show error when no error prop", () => {
    render(
      <FormDialog open={true} onOpenChange={() => {}} title="Create" actions={<button>OK</button>}>
        <div>content</div>
      </FormDialog>,
    );

    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("delegates open/onOpenChange to Dialog", () => {
    const onOpenChange = vi.fn();

    const { rerender } = render(
      <FormDialog
        open={false}
        onOpenChange={onOpenChange}
        title="Hidden"
        actions={<button>OK</button>}
      >
        <div>content</div>
      </FormDialog>,
    );

    // When open is false, Dialog does not render content
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();

    // When open is true, Dialog renders content
    rerender(
      <FormDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Hidden"
        actions={<button>OK</button>}
      >
        <div>content</div>
      </FormDialog>,
    );

    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });
});
