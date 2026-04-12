import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockSendMessage = vi.fn();
const mockClearMessages = vi.fn();
const mockSetExplore = vi.fn();

let mockMessages: {
  role: string;
  content: string;
  attachments?: { name: string; mimeType: string; size: number; path?: string }[];
}[] = [];
let mockIsStreaming = false;
let mockExplore = false;
let mockChatErrorCode: string | null = null;
let mockActiveSessionId: string | null = null;
let mockEffectiveChatRuntime: {
  source: string;
  profile: {
    name: string;
    runtimeId: string;
    providerId: string;
    defaultModel: string | null;
  } | null;
  resolved?: { runtimeId: string; providerId: string; model: string | null };
} | null = null;

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
    activeSessionId: mockActiveSessionId,
    setActiveSessionId: vi.fn(),
    pinActiveSession: vi.fn(),
    clearActiveSession: vi.fn(),
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

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useEffectiveChatRuntime: () => ({
    data: mockEffectiveChatRuntime,
  }),
  useRuntimeProfiles: () => ({
    data: [],
  }),
}));

const { ChatPanel } = await import("@/components/chat/ChatPanel");

const mockOnClose = vi.fn();

function renderPanel(
  overrides: Partial<{
    isOpen: boolean;
    projectId: string | null;
    projectName: string | null;
    taskId: string | null;
  }> = {},
) {
  return render(
    <ChatPanel
      isOpen={true}
      projectId="p-1"
      projectName="Project One"
      taskId={null}
      onClose={mockOnClose}
      {...overrides}
    />,
  );
}

describe("ChatPanel", () => {
  beforeEach(() => {
    mockMessages = [];
    mockIsStreaming = false;
    mockExplore = false;
    mockChatErrorCode = null;
    mockActiveSessionId = null;
    mockEffectiveChatRuntime = null;
    mockSendMessage.mockClear();
    mockClearMessages.mockClear();
    mockSetExplore.mockClear();
    mockOnClose.mockClear();
  });

  it("shows active chat runtime profile and model", () => {
    mockEffectiveChatRuntime = {
      source: "project_default",
      profile: {
        name: "GLM Claude",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "glm-5",
      },
      resolved: {
        runtimeId: "claude",
        providerId: "anthropic",
        model: "glm-5",
      },
    };

    renderPanel();

    expect(screen.getByText("Profile:")).toBeDefined();
    expect(screen.getByText("GLM Claude")).toBeDefined();
    expect(screen.getByText("Runtime:")).toBeDefined();
    expect(screen.getByText("claude/anthropic")).toBeDefined();
    expect(screen.getByText("Model:")).toBeDefined();
    expect(screen.getByText("glm-5")).toBeDefined();
  });

  it("shows the current project scope in the header", () => {
    renderPanel();
    expect(screen.getByText("Project:")).toBeDefined();
    expect(screen.getByText("Project One")).toBeDefined();
  });

  it("shows empty state when no messages", () => {
    renderPanel();
    expect(screen.getByText('Ask anything about "Project One"')).toBeDefined();
  });

  it("renders user and assistant messages", () => {
    mockMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    renderPanel();
    expect(screen.getByText("Hello")).toBeDefined();
    expect(screen.getByText("Hi there!")).toBeDefined();
  });

  it("sends message on Enter key", () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendMessage).toHaveBeenCalledWith("test message", undefined, false);
  });

  it("does not send message on Shift+Enter", () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "test" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends message on send button click", () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "hello" } });
    const sendButton = screen.getByLabelText("Send message");
    fireEvent.click(sendButton);
    expect(mockSendMessage).toHaveBeenCalledWith("hello", undefined, false);
  });

  it("shows Explore checkbox toggle", () => {
    renderPanel();
    expect(screen.getByText("Explore")).toBeDefined();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(mockSetExplore).toHaveBeenCalled();
  });

  it("shows typing indicator when streaming and no assistant message yet", () => {
    mockIsStreaming = true;
    mockMessages = [{ role: "user", content: "Hello" }];
    renderPanel();
    expect(screen.getByText("Working...")).toBeDefined();
  });

  it("shows typing indicator when streaming even with assistant message", () => {
    mockIsStreaming = true;
    mockMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Partial..." },
    ];
    renderPanel();
    expect(screen.getByText("Working...")).toBeDefined();
  });

  it("clears messages on clear button click", () => {
    renderPanel();
    const clearButton = screen.getByLabelText("Clear messages");
    fireEvent.click(clearButton);
    expect(mockClearMessages).toHaveBeenCalledOnce();
  });

  it("shows usage limit banner when chat error code is CHAT_USAGE_LIMIT", () => {
    mockChatErrorCode = "CHAT_USAGE_LIMIT";
    renderPanel();
    expect(screen.getByText("Usage Limit Reached")).toBeDefined();
    expect(
      screen.getByText(
        "Runtime usage limit is currently exhausted. Wait for reset time and send again.",
      ),
    ).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    renderPanel();
    const closeButton = screen.getByLabelText("Close chat");
    fireEvent.click(closeButton);
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    renderPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on outside click", () => {
    renderPanel();
    fireEvent.pointerDown(document.body);
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose on inside click", () => {
    renderPanel();
    fireEvent.pointerDown(screen.getByText("AI Chat"));
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("is hidden when isOpen is false", () => {
    renderPanel({ isOpen: false });
    // Portal renders to document.body
    const panel = document.body.querySelector("[class*='-translate-x-full']");
    expect(panel).not.toBeNull();
  });

  it("renders a single attachment badge on a user message", () => {
    mockMessages = [
      {
        role: "user",
        content: "Check this file",
        attachments: [{ name: "report.csv", mimeType: "text/csv", size: 1234 }],
      },
    ];
    renderPanel();
    expect(screen.getByText("report.csv")).toBeDefined();
  });

  it("renders multiple attachment badges on a user message", () => {
    mockMessages = [
      {
        role: "user",
        content: "Check these files",
        attachments: [
          { name: "photo1.jpg", mimeType: "image/jpeg", size: 50000 },
          { name: "photo2.png", mimeType: "image/png", size: 60000 },
          { name: "data.json", mimeType: "application/json", size: 1500 },
        ],
      },
    ];
    renderPanel();
    expect(screen.getByText("photo1.jpg")).toBeDefined();
    expect(screen.getByText("photo2.png")).toBeDefined();
    expect(screen.getByText("data.json")).toBeDefined();
  });

  it("renders attachment as download link when path is present and session is active", () => {
    mockActiveSessionId = "session-123";
    mockMessages = [
      {
        role: "user",
        content: "Here is a file",
        attachments: [
          {
            name: "doc.pdf",
            mimeType: "application/pdf",
            size: 9999,
            path: ".ai-factory/files/chat/session-123/doc.pdf",
          },
        ],
      },
    ];
    renderPanel();
    const link = screen.getByText("doc.pdf").closest("a");
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe("/chat/sessions/session-123/attachments/doc.pdf");
    expect(link!.getAttribute("download")).toBe("doc.pdf");
  });

  it("renders attachment as plain badge when no path (just sent, not yet saved)", () => {
    mockMessages = [
      {
        role: "user",
        content: "Uploading",
        attachments: [{ name: "new-file.txt", mimeType: "text/plain", size: 100 }],
      },
    ];
    renderPanel();
    const el = screen.getByText("new-file.txt");
    expect(el.closest("a")).toBeNull();
    expect(el.closest("span")).toBeDefined();
  });

  it("renders attachment as plain badge when no active session", () => {
    mockActiveSessionId = null;
    mockMessages = [
      {
        role: "user",
        content: "No session",
        attachments: [
          {
            name: "file.txt",
            mimeType: "text/plain",
            size: 50,
            path: ".ai-factory/files/chat/x/file.txt",
          },
        ],
      },
    ];
    renderPanel();
    const el = screen.getByText("file.txt");
    expect(el.closest("a")).toBeNull();
  });

  it("does not render attachment section when message has no attachments", () => {
    mockMessages = [{ role: "user", content: "Plain message" }];
    renderPanel();
    // Portal renders to document.body — query there
    const messageBubbles = document.body.querySelectorAll(".bg-blue-600\\/15");
    expect(messageBubbles.length).toBe(1);
    expect(messageBubbles[0].querySelector(".flex-wrap")).toBeNull();
  });
});
