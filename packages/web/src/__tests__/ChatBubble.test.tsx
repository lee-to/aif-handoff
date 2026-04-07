import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { ChatBubble } = await import("@/components/chat/ChatBubble");

describe("ChatBubble", () => {
  it("renders with Bot icon when closed", () => {
    render(<ChatBubble isOpen={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Open chat" });
    expect(button).toBeDefined();
  });

  it("renders nothing when open", () => {
    const { container } = render(<ChatBubble isOpen={true} onToggle={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<ChatBubble isOpen={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("does not apply pulse-glow animation", () => {
    render(<ChatBubble isOpen={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Open chat" });
    expect(button.className).not.toContain("animate-pulse-glow");
  });
});
