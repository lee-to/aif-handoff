import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockSendMessage = vi.fn();
const mockClearMessages = vi.fn();
const mockSetExplore = vi.fn();

let mockMessages: { role: string; content: string }[] = [];
let mockIsStreaming = false;
let mockExplore = false;
let mockChatErrorCode: string | null = null;

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: mockMessages,
    isStreaming: mockIsStreaming,
    chatErrorCode: mockChatErrorCode,
    explore: mockExplore,
    setExplore: mockSetExplore,
    sendMessage: mockSendMessage,
    clearMessages: mockClearMessages,
    newSession: vi.fn(),
  }),
}));

vi.mock("@/hooks/useChatSessions", () => ({
  useChatSessions: () => ({
    sessions: [],
    isLoading: false,
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    loadSessionMessages: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTask: () => ({ data: null }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { ChatPanel } = await import("@/components/chat/ChatPanel");

const mockOnClose = vi.fn();

describe("ChatPanel", () => {
  beforeEach(() => {
    mockMessages = [];
    mockIsStreaming = false;
    mockExplore = false;
    mockChatErrorCode = null;
    mockSendMessage.mockClear();
    mockClearMessages.mockClear();
    mockSetExplore.mockClear();
    mockOnClose.mockClear();
  });

  it("shows empty state when no messages", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Ask anything about this project")).toBeDefined();
  });

  it("renders user and assistant messages", () => {
    mockMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Hello")).toBeDefined();
    expect(screen.getByText("Hi there!")).toBeDefined();
  });

  it("sends message on Enter key", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendMessage).toHaveBeenCalledWith("test message");
  });

  it("does not send message on Shift+Enter", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "test" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends message on send button click", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "hello" } });
    // Click the send button (it's the button with Send icon in the input area)
    const buttons = screen.getAllByRole("button");
    const sendButton = buttons.find((btn) => !btn.hasAttribute("title"));
    if (sendButton) fireEvent.click(sendButton);
    expect(mockSendMessage).toHaveBeenCalledWith("hello");
  });

  it("shows Explore checkbox toggle", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Explore")).toBeDefined();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(mockSetExplore).toHaveBeenCalled();
  });

  it("shows typing indicator when streaming and no assistant message yet", () => {
    mockIsStreaming = true;
    mockMessages = [{ role: "user", content: "Hello" }];
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Working...")).toBeDefined();
  });

  it("shows typing indicator when streaming even with assistant message", () => {
    mockIsStreaming = true;
    mockMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Partial..." },
    ];
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Working...")).toBeDefined();
  });

  it("clears messages on clear button click", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    const clearButton = screen.getByTitle("Clear messages");
    fireEvent.click(clearButton);
    expect(mockClearMessages).toHaveBeenCalledOnce();
  });

  it("shows usage limit banner when chat error code is CHAT_USAGE_LIMIT", () => {
    mockChatErrorCode = "CHAT_USAGE_LIMIT";
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    expect(screen.getByText("Usage Limit Reached")).toBeDefined();
    expect(
      screen.getByText(
        "Claude usage limit is currently exhausted. Wait for reset time and send again.",
      ),
    ).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    const closeButton = screen.getByTitle("Close chat");
    fireEvent.click(closeButton);
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on outside click", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    fireEvent.mouseDown(document.body);
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose on inside click", () => {
    render(<ChatPanel isOpen={true} projectId="p-1" taskId={null} onClose={mockOnClose} />);
    fireEvent.mouseDown(screen.getByText("AI Chat"));
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("is hidden when isOpen is false", () => {
    const { container } = render(
      <ChatPanel isOpen={false} projectId="p-1" taskId={null} onClose={mockOnClose} />,
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain("-translate-x-full");
  });
});
