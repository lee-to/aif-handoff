import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockSendMessage = vi.fn();
const mockClearMessages = vi.fn();
const mockSetExplore = vi.fn();
const mockPinActiveSession = vi.fn();
const mockClearActiveSession = vi.fn();
const mockClaimSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockRenameSession = vi.fn();
const mockSetActiveSessionId = vi.fn();
const mockNewSession = vi.fn();
const mockCreateObjective = vi.fn();
const mockUpdateObjective = vi.fn();
const mockLinkTask = vi.fn();
const mockUnlinkTask = vi.fn();
const mockUpdateThreadStatus = vi.fn();

let mockMessages: {
  role: string;
  content: string;
  attachments?: { name: string; mimeType: string; size: number; path?: string }[];
}[] = [];
let mockIsStreaming = false;
let mockExplore = false;
let mockChatErrorCode: string | null = null;
let mockChatRuntimeLimitSnapshot: {
  source: string;
  status: string;
  precision: string;
  checkedAt: string;
  providerId: string;
  runtimeId?: string | null;
  profileId?: string | null;
  primaryScope?: string | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
  warningThreshold?: number | null;
  windows: Array<Record<string, unknown>>;
  providerMeta?: Record<string, unknown> | null;
} | null = null;
let mockActiveSessionId: string | null = null;
let mockSessions: Array<Record<string, unknown>> = [];
let mockRuntimeProfiles: Array<Record<string, unknown>> = [];
let mockEffectiveChatRuntime: {
  source: string;
  profile: {
    name: string;
    projectId?: string | null;
    runtimeId: string;
    providerId: string;
    defaultModel: string | null;
    runtimeLimitSnapshot?: Record<string, unknown> | null;
    runtimeLimitUpdatedAt?: string | null;
  } | null;
  resolved?: { runtimeId: string; providerId: string; model: string | null };
} | null = null;
let mockWorkspace: Record<string, unknown> | undefined;
let mockWorkspaceError: string | null = null;
let mockClaimError: string | null = null;
let mockIsClaiming = false;
let mockProjectTasks: Array<Record<string, unknown>> = [];

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: mockMessages,
    isStreaming: mockIsStreaming,
    chatErrorCode: mockChatErrorCode,
    chatRuntimeLimitSnapshot: mockChatRuntimeLimitSnapshot,
    explore: mockExplore,
    setExplore: mockSetExplore,
    sendMessage: mockSendMessage,
    clearMessages: mockClearMessages,
    newSession: mockNewSession,
  }),
}));

vi.mock("@/hooks/useChatSessions", () => ({
  useChatSessions: () => ({
    sessions: mockSessions,
    isLoading: false,
    activeSessionId: mockActiveSessionId,
    setActiveSessionId: mockSetActiveSessionId,
    pinActiveSession: mockPinActiveSession,
    clearActiveSession: mockClearActiveSession,
    claimSession: mockClaimSession,
    isClaiming: mockIsClaiming,
    claimError: mockClaimError,
    createSession: vi.fn(),
    deleteSession: mockDeleteSession,
    renameSession: mockRenameSession,
    loadSessionMessages: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTask: () => ({ data: null }),
  useTasks: () => ({ data: mockProjectTasks }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useThreadWorkspace", () => ({
  useThreadWorkspace: () => ({
    workspace: mockWorkspace,
    isLoading: false,
    error: mockWorkspaceError,
    createObjective: mockCreateObjective,
    updateObjective: mockUpdateObjective,
    linkTask: mockLinkTask,
    unlinkTask: mockUnlinkTask,
    updateStatus: mockUpdateThreadStatus,
  }),
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useEffectiveChatRuntime: () => ({
    data: mockEffectiveChatRuntime,
  }),
  useRuntimeProfiles: () => ({
    data: mockRuntimeProfiles,
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
    embedded: boolean;
    kerryPilotMode: boolean;
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
    mockChatRuntimeLimitSnapshot = null;
    mockActiveSessionId = null;
    mockSessions = [];
    mockRuntimeProfiles = [];
    mockEffectiveChatRuntime = null;
    mockWorkspace = undefined;
    mockWorkspaceError = null;
    mockClaimError = null;
    mockIsClaiming = false;
    mockProjectTasks = [];
    mockSendMessage.mockClear();
    mockClearMessages.mockClear();
    mockSetExplore.mockClear();
    mockPinActiveSession.mockClear();
    mockClearActiveSession.mockClear();
    mockClaimSession.mockClear();
    mockClaimSession.mockResolvedValue({});
    mockDeleteSession.mockClear();
    mockRenameSession.mockClear();
    mockSetActiveSessionId.mockClear();
    mockNewSession.mockClear();
    mockCreateObjective.mockClear();
    mockUpdateObjective.mockClear();
    mockLinkTask.mockClear();
    mockUnlinkTask.mockClear();
    mockUpdateThreadStatus.mockClear();
    mockOnClose.mockClear();
  });

  it("disables chat execution in Kerry pilot mode", () => {
    renderPanel({ kerryPilotMode: true });
    expect(screen.getByPlaceholderText("Execution is disabled in pilot mode")).toBeDisabled();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("shows active chat runtime profile and model", () => {
    mockEffectiveChatRuntime = {
      source: "project_default",
      profile: {
        name: "GLM Claude",
        projectId: "p-1",
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
    expect(screen.getByText("GLM Claude [Project]")).toBeDefined();
    expect(screen.getByText("Runtime:")).toBeDefined();
    expect(screen.getByText("claude/anthropic")).toBeDefined();
    expect(screen.getByText("Model:")).toBeDefined();
    expect(screen.getByText("glm-5")).toBeDefined();
  });

  it("shows app-default label when chat resolves through the global fallback chain", () => {
    mockEffectiveChatRuntime = {
      source: "system_default",
      profile: null,
      resolved: {
        runtimeId: "codex",
        providerId: "openai",
        model: "gpt-5.4",
      },
    };

    renderPanel();

    expect(screen.getByText("App default")).toBeDefined();
    expect(screen.getByText("codex/openai")).toBeDefined();
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

  it("shows thread objectives, linked tasks, and pull request evidence", () => {
    mockActiveSessionId = "session-1";
    mockSessions = [
      {
        id: "session-1",
        title: "Thread first",
        source: "web",
        status: "wip",
        runtimeProfileId: null,
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    ];
    mockWorkspace = {
      thread: {
        ...mockSessions[0],
        projectId: "p-1",
        agentSessionId: null,
        createdAt: "2026-08-19T00:00:00.000Z",
      },
      objectives: [
        { id: "objective-1", title: "Ship the feature", status: "open", required: true },
      ],
      tasks: [
        {
          taskId: "task-1",
          title: "Implement workspace",
          status: "review",
          objectiveId: "objective-1",
          prNumber: 42,
          prUrl: "https://github.com/example/repo/pull/42",
          prState: "open",
        },
      ],
    };

    renderPanel({ embedded: true });

    expect(screen.getByText("Ship the feature")).toBeDefined();
    expect(screen.getByText("Implement workspace")).toBeDefined();
    expect(screen.getByRole("link", { name: /PR #42/ })).toBeDefined();
  });

  it("claims a discovered runtime chat without sending a model message", () => {
    mockActiveSessionId = "runtime:codex:runtime-1";
    mockSessions = [
      {
        id: "runtime:codex:runtime-1",
        projectId: "p-1",
        title: "Existing Codex chat",
        source: "cli",
        runtimeProfileId: "profile-1",
        runtimeSessionId: "runtime-1",
        status: "open",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    ];

    renderPanel({ embedded: true });
    fireEvent.click(screen.getByRole("button", { name: "Add objectives and tasks" }));

    expect(mockClaimSession).toHaveBeenCalledWith(mockSessions[0]);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("disables the claim action and shows claim errors", () => {
    mockActiveSessionId = "runtime:codex:runtime-1";
    mockSessions = [
      {
        id: "runtime:codex:runtime-1",
        title: "Existing Codex chat",
        source: "cli",
        runtimeSessionId: "runtime-1",
      },
    ];
    mockIsClaiming = true;
    mockClaimError = "Runtime session not found in this project";

    renderPanel({ embedded: true });

    expect(screen.getByRole("button", { name: "Adding..." })).toHaveProperty("disabled", true);
    expect(screen.getByText("Runtime session not found in this project")).toBeDefined();
  });

  it("shows workspace loading errors even when no workspace data loaded", () => {
    mockActiveSessionId = "session-1";
    mockSessions = [
      {
        id: "session-1",
        title: "Broken workspace",
        source: "web",
        runtimeProfileId: null,
      },
    ];
    mockWorkspaceError = "Unable to load thread workspace";

    renderPanel({ embedded: true });

    expect(screen.getByText("Unable to load thread workspace")).toBeDefined();
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

  it("shows the pinned session runtime and keeps sending in that session when defaults change", () => {
    mockActiveSessionId = "session-1";
    mockSessions = [
      {
        id: "session-1",
        title: "Pinned session",
        runtimeProfileId: "profile-saved",
      },
    ];
    mockRuntimeProfiles = [
      {
        id: "profile-saved",
        name: "Saved Runtime",
        projectId: null,
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "sonnet",
      },
    ];
    mockEffectiveChatRuntime = {
      source: "project_default",
      profile: {
        name: "Current Default",
        projectId: "p-1",
        runtimeId: "codex",
        providerId: "openai",
        defaultModel: "gpt-5.4",
      },
      resolved: {
        runtimeId: "codex",
        providerId: "openai",
        model: "gpt-5.4",
      },
    };

    renderPanel();
    expect(screen.getByText("Saved Runtime [Global]")).toBeDefined();
    expect(screen.queryByText("Current Default [Project]")).toBeNull();
    const textarea = screen.getByPlaceholderText("Ask a question...");
    fireEvent.change(textarea, { target: { value: "stay pinned" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(mockPinActiveSession).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith("stay pinned", undefined, false);
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
    mockChatRuntimeLimitSnapshot = {
      source: "api_headers",
      status: "blocked",
      precision: "exact",
      checkedAt: "2026-04-17T00:00:00.000Z",
      providerId: "anthropic",
      runtimeId: "claude",
      primaryScope: "requests",
      resetAt: "2099-04-17T01:00:00.000Z",
      warningThreshold: 10,
      windows: [{ scope: "requests", percentRemaining: 0, warningThreshold: 10 }],
      providerMeta: null,
    };
    renderPanel();
    expect(screen.getByText("Runtime Blocked")).toBeDefined();
    expect(
      screen.getByText("Request quota crossed the 10% safety threshold (0% remaining)."),
    ).toBeDefined();
    expect(screen.getByText(/Provider reset/)).toBeDefined();
  });

  it("shows a persistent runtime limit banner from the active profile even without a chat error", () => {
    mockEffectiveChatRuntime = {
      source: "project_default",
      profile: {
        name: "Claude Team",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "claude-sonnet",
        runtimeLimitSnapshot: {
          source: "api_headers",
          status: "warning",
          precision: "exact",
          checkedAt: "2026-04-17T00:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-1",
          primaryScope: "requests",
          resetAt: "2099-04-17T01:00:00.000Z",
          warningThreshold: 10,
          windows: [{ scope: "requests", percentRemaining: 8, warningThreshold: 10 }],
          providerMeta: null,
        },
        runtimeLimitUpdatedAt: "2026-04-17T00:00:00.000Z",
      },
      resolved: {
        runtimeId: "claude",
        providerId: "anthropic",
        model: "claude-sonnet",
      },
    };

    renderPanel();

    expect(screen.getByText("Runtime Near Limit")).toBeDefined();
    expect(screen.getAllByText(/Claude Team/).length).toBeGreaterThan(0);
    expect(screen.getByText("Request quota is at 8% remaining (threshold 10%).")).toBeDefined();
    expect(screen.getByText(/Provider reset/)).toBeDefined();
  });

  it("shows a neutral banner when the runtime limit signal has no active reset hint", () => {
    mockChatErrorCode = "CHAT_USAGE_LIMIT";
    mockChatRuntimeLimitSnapshot = {
      source: "sdk_event",
      status: "blocked",
      precision: "heuristic",
      checkedAt: "2026-04-17T00:00:00.000Z",
      providerId: "anthropic",
      runtimeId: "claude",
      primaryScope: "time",
      resetAt: null,
      warningThreshold: null,
      windows: [{ scope: "time", percentRemaining: 4, resetAt: null }],
      providerMeta: { status: "rejected" },
    };
    renderPanel();
    expect(screen.getByText("Limit Signal (No Reset)")).toBeDefined();
    expect(screen.getByText(/without a future reset hint/i)).toBeDefined();
    expect(screen.queryByText(/Provider reset/)).toBeNull();
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
    fireEvent.pointerDown(screen.getByText("New Thread"));
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
