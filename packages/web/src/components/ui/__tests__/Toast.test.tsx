import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider, useToast } from "../toast";

function TestTrigger() {
  const { toast } = useToast();
  return (
    <>
      <button type="button" onClick={() => toast("Success!", "success")}>
        Show success
      </button>
      <button type="button" onClick={() => toast("Error!", "error")}>
        Show error
      </button>
      <button type="button" onClick={() => toast("Warning!", "warning")}>
        Show warning
      </button>
      <button type="button" onClick={() => toast("Info!", "info")}>
        Show info
      </button>
      <button type="button" onClick={() => toast("No auto-dismiss", "info", 0)}>
        Persistent
      </button>
    </>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows toast on trigger", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Show success"));
    expect(screen.getByText("Success!")).toBeInTheDocument();
  });

  it("shows different variants", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Show error"));
    expect(screen.getByText("Error!")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show warning"));
    expect(screen.getByText("Warning!")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show info"));
    expect(screen.getByText("Info!")).toBeInTheDocument();
  });

  it("auto-dismisses after duration", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Show success"));
    expect(screen.getByText("Success!")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4500));
    expect(screen.queryByText("Success!")).not.toBeInTheDocument();
  });

  it("can be dismissed manually", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Show info"));
    expect(screen.getByText("Info!")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Info!")).not.toBeInTheDocument();
  });

  it("does not auto-dismiss when duration is 0", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Persistent"));
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("No auto-dismiss")).toBeInTheDocument();
  });

  it("has aria-live region", () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );
    const region = document.querySelector("[aria-live='polite']");
    expect(region).toBeInTheDocument();
  });

  it("throws when useToast is used outside provider", () => {
    expect(() => render(<TestTrigger />)).toThrow("useToast must be used within <ToastProvider>");
  });
});
