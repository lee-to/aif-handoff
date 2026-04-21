import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockSendChatMessage = vi.fn();
const mockGetChatSessionMessages = vi.fn();
const mockAbortChat = vi.fn();
const mockGetWsClientId = vi.fn();
const WS_CLIENT_ID_WAIT_TIMEOUT_MS = 500;

class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

vi.mock("@/lib/api", () => ({
  ApiError,
  api: {
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
    getChatSessionMessages: (...args: unknown[]) => mockGetChatSessionMessages(...args),
    abortChat: (...args: unknown[]) => mockAbortChat(...args),
  },
}));

vi.mock("@/hooks/useWebSocket", () => ({
  getWsClientId: () => mockGetWsClientId(),
}));

const { useChat } = await import("@/hooks/useChat");

describe("useChat", () => {
  beforeEach(() => {
    mockSendChatMessage.mockReset();
    mockGetChatSessionMessages.mockReset();
    mockAbortChat.mockReset();
    mockAbortChat.mockResolvedValue(undefined);
    mockGetWsClientId.mockReset();
    mockGetWsClientId.mockReturnValue("test-client-id");
    mockSendChatMessage.mockResolvedValue({ conversationId: "conv-1", sessionId: "sess-1" });
    mockGetChatSessionMessages.mockResolvedValue([]);
  });

  it("starts with empty messages", () => {
    const { result } = renderHook(() => useChat("p-1"));
    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.chatErrorCode).toBeNull();
  });

  it("sends message and adds user message to list", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(result.current.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(mockSendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        message: "Hello",
        clientId: "test-client-id",
        explore: false,
      }),
    );
    // conversationId is generated client-side as a UUID
    expect(mockSendChatMessage.mock.calls[0][0].conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does not send empty messages", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("   ");
    });

    expect(result.current.messages).toEqual([]);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("does not send when projectId is null", async () => {
    const { result } = renderHook(() => useChat(null));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("accumulates tokens from chat:token events", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    // Simulate chat:token events
    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:token", {
          detail: { conversationId, token: "Hello " },
        }),
      );
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toEqual({ role: "assistant", content: "Hello " });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:token", {
          detail: { conversationId, token: "world!" },
        }),
      );
    });

    expect(result.current.messages[1]).toEqual({ role: "assistant", content: "Hello world!" });
  });

  it("stops streaming on chat:done event", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:done", {
          detail: { conversationId },
        }),
      );
    });

    expect(result.current.isStreaming).toBe(false);
  });

  it("shows server stream error message from chat:error event", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:error", {
          detail: { conversationId, message: "You're out of extra usage · resets 7pm" },
        }),
      );
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.chatErrorCode).toBeNull();
    expect(result.current.messages[result.current.messages.length - 1]).toEqual({
      role: "assistant",
      content: "You're out of extra usage · resets 7pm",
    });
  });

  it("stores CHAT_USAGE_LIMIT code from chat:error event", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:error", {
          detail: {
            conversationId,
            message: "You're out of extra usage · resets 7pm",
            code: "CHAT_USAGE_LIMIT",
          },
        }),
      );
    });

    expect(result.current.chatErrorCode).toBe("CHAT_USAGE_LIMIT");
  });

  it("clears messages and resets state", async () => {
    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    act(() => {
      result.current.clearMessages();
    });

    expect(result.current.messages).toEqual([]);
  });

  it("loads messages when sessionId changes", async () => {
    mockGetChatSessionMessages.mockResolvedValueOnce([
      {
        id: "m1",
        sessionId: "sess-1",
        role: "user",
        content: "Saved msg",
        createdAt: "2026-01-01",
      },
    ]);

    const { result, rerender } = renderHook(({ pid, sid }) => useChat(pid, sid), {
      initialProps: { pid: "p-1" as string | null, sid: null as string | null },
    });

    expect(result.current.messages).toEqual([]);

    await act(async () => {
      rerender({ pid: "p-1", sid: "sess-1" });
      // Flush the async load
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(mockGetChatSessionMessages).toHaveBeenCalledWith("sess-1");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("Saved msg");
  });

  it("handles send failure gracefully", async () => {
    mockSendChatMessage.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].content).toContain("Network error");
    expect(result.current.isStreaming).toBe(false);
  });

  it("falls back to HTTP response when websocket clientId is unavailable", async () => {
    vi.useFakeTimers();
    mockGetWsClientId.mockReturnValue(null);
    mockSendChatMessage.mockResolvedValueOnce({
      conversationId: "conv-http-1",
      sessionId: "sess-http-1",
      assistantMessage: "HTTP fallback reply",
    });

    const { result } = renderHook(() => useChat("p-1"));

    try {
      await act(async () => {
        const sendPromise = result.current.sendMessage("Hello");
        await vi.advanceTimersByTimeAsync(WS_CLIENT_ID_WAIT_TIMEOUT_MS);
        await sendPromise;
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(mockSendChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p-1",
          message: "Hello",
        }),
      );
      expect(mockSendChatMessage.mock.calls[0][0].clientId).toBeUndefined();
      expect(result.current.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "HTTP fallback reply" },
      ]);
      expect(result.current.isStreaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("promotes the resolved session id after the first send", async () => {
    const handleSessionResolved = vi.fn();
    mockSendChatMessage.mockResolvedValueOnce({
      conversationId: "conv-2",
      sessionId: "sess-2",
    });

    const { result } = renderHook(() => useChat("p-1", null, null, handleSessionResolved));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(handleSessionResolved).toHaveBeenCalledWith("sess-2");
  });

  it("does not duplicate error message when ws chat:error and http failure happen together", async () => {
    let rejectSend: ((reason?: unknown) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    let sendPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("Hello");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:error", {
          detail: { conversationId, message: "Chat request failed" },
        }),
      );
    });

    await act(async () => {
      rejectSend!(new Error("Chat request failed"));
      await sendPromise;
    });

    const assistantErrors = result.current.messages.filter(
      (m) => m.role === "assistant" && m.content === "Chat request failed",
    );
    expect(assistantErrors).toHaveLength(1);
  });

  it("keeps the websocket stream active after the first token arrives", async () => {
    vi.useFakeTimers();
    mockSendChatMessage.mockResolvedValueOnce({
      conversationId: "conv-stream-1",
      sessionId: "sess-stream-1",
      assistantMessage: "HTTP fallback reply",
    });

    const { result } = renderHook(() => useChat("p-1"));

    try {
      await act(async () => {
        await result.current.sendMessage("Hello");
      });

      const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

      act(() => {
        window.dispatchEvent(
          new CustomEvent("chat:token", {
            detail: { conversationId, token: "Hello " },
          }),
        );
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.messages[result.current.messages.length - 1]).toEqual({
        role: "assistant",
        content: "Hello ",
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent("chat:token", {
            detail: { conversationId, token: "world!" },
          }),
        );
      });

      expect(result.current.messages[result.current.messages.length - 1]).toEqual({
        role: "assistant",
        content: "Hello world!",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort targets the currently viewed session when multiple streams are in flight", async () => {
    // Stream A: pending on session "sess-A"
    let resolveA: ((v: { conversationId: string; sessionId: string }) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    // Stream B: pending on session "sess-B"
    let resolveB: ((v: { conversationId: string; sessionId: string }) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveB = resolve;
        }),
    );

    // Hook A bound to session A; Hook B to session B — they share the abort registry
    // via activeStreamsRef only within one hook instance, so simulate the real scenario
    // with a single hook switching its viewed session.
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useChat("p-1", sid),
      { initialProps: { sid: "sess-A" as string | null } },
    );

    // Start stream for session A
    let sendAPromise: Promise<void>;
    act(() => {
      sendAPromise = result.current.sendMessage("A");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));
    const convA = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    // Switch to session B — wait for the effect to clear isStreaming — then send
    await act(async () => {
      rerender({ sid: "sess-B" });
      await new Promise((r) => setTimeout(r, 0));
    });
    let sendBPromise: Promise<void>;
    act(() => {
      sendBPromise = result.current.sendMessage("B");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(2));
    const convB = mockSendChatMessage.mock.calls[1][0].conversationId as string;

    // Switch back to A and hit Stop — must abort A's conversation, not B's
    rerender({ sid: "sess-A" });
    await act(async () => {
      await result.current.abortStream();
    });

    expect(mockAbortChat).toHaveBeenCalledTimes(1);
    expect(mockAbortChat).toHaveBeenCalledWith(convA);
    expect(convA).not.toBe(convB);

    // Clean up pending promises
    await act(async () => {
      resolveA?.({ conversationId: convA, sessionId: "sess-A" });
      resolveB?.({ conversationId: convB, sessionId: "sess-B" });
      await sendAPromise;
      await sendBPromise;
    });
  });

  it("resolves the active session when aborting the first message in a new chat", async () => {
    const handleSessionResolved = vi.fn();
    mockSendChatMessage.mockRejectedValueOnce(
      new ApiError("Chat run aborted by user", 409, {
        code: "aborted",
        sessionId: "sess-new-1",
        conversationId: "conv-new-1",
      }),
    );

    const { result } = renderHook(() => useChat("p-1", null, null, handleSessionResolved));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(handleSessionResolved).toHaveBeenCalledWith("sess-new-1");
  });

  it("rolls back the optimistic first message when abort returns without sessionId", async () => {
    mockSendChatMessage.mockRejectedValueOnce(
      new ApiError("Chat run aborted by user", 409, {
        code: "aborted",
        sessionId: null,
        conversationId: "conv-new-orphan-1",
      }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.chatErrorCode).toBe("aborted");
    expect(result.current.isStreaming).toBe(false);
  });

  it("does not clear Stop or show Stopped on session B when session A's run aborts in the background", async () => {
    // Stream A: resolvable by us, simulates A's HTTP settling after user switches away
    let rejectA: ((reason?: unknown) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    // Stream B: pending forever for this test
    let resolveB: ((v: { conversationId: string; sessionId: string }) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveB = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useChat("p-1", sid),
      { initialProps: { sid: "sess-A" as string | null } },
    );

    // Kick off stream for A
    let sendAPromise: Promise<void>;
    act(() => {
      sendAPromise = result.current.sendMessage("A");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));
    const convA = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    // Switch to B and kick off its stream
    await act(async () => {
      rerender({ sid: "sess-B" });
      await new Promise((r) => setTimeout(r, 0));
    });
    let sendBPromise: Promise<void>;
    act(() => {
      sendBPromise = result.current.sendMessage("B");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(2));

    // While the user is still viewing B, A's HTTP request aborts with 409.
    await act(async () => {
      rejectA!(
        new ApiError("Chat run aborted by user", 409, {
          code: "aborted",
          sessionId: "sess-A",
          conversationId: convA,
          assistantMessage: null,
        }),
      );
      await sendAPromise;
    });

    // B is still streaming — Stop must stay, no "Stopped" banner must appear.
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.chatErrorCode).toBeNull();

    // Clean up
    await act(async () => {
      resolveB?.({ conversationId: "conv-B", sessionId: "sess-B" });
      await sendBPromise;
    });
  });

  it("appends the partial assistant reply from the 409 abort body when no WS tokens arrived", async () => {
    mockGetWsClientId.mockReturnValue(null);
    mockSendChatMessage.mockRejectedValueOnce(
      new ApiError("Chat run aborted by user", 409, {
        code: "aborted",
        sessionId: "sess-partial-1",
        conversationId: "conv-partial-1",
        assistantMessage: "half-written answer",
      }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("question");
    });

    expect(result.current.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "half-written answer" },
    ]);
    expect(result.current.chatErrorCode).toBe("aborted");
    expect(result.current.isStreaming).toBe(false);
  });

  it("upgrades user message attachments from the 409 abort body", async () => {
    mockSendChatMessage.mockRejectedValueOnce(
      new ApiError("Chat run aborted by user", 409, {
        code: "aborted",
        sessionId: "sess-att-1",
        conversationId: "conv-att-1",
        attachments: [
          {
            name: "plan.md",
            mimeType: "text/markdown",
            size: 12,
            path: "storage/chat/s1/plan.md",
          },
        ],
      }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    await act(async () => {
      await result.current.sendMessage("take a look", [
        { name: "plan.md", mimeType: "text/markdown", size: 12, content: "hello" },
      ]);
    });

    const userMessage = result.current.messages.find((m) => m.role === "user");
    expect(userMessage?.attachments?.[0]).toEqual(
      expect.objectContaining({
        name: "plan.md",
        path: "storage/chat/s1/plan.md",
      }),
    );
  });

  it("upgrades user message attachments when chat:error races ahead of the 409 abort body", async () => {
    let rejectSend: ((reason?: unknown) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    let sendPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("take a look", [
        { name: "plan.md", mimeType: "text/markdown", size: 12, content: "hello" },
      ]);
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    // WS `chat:error` with code=aborted arrives first — this clears the
    // in-flight stream state before the HTTP 409 lands.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:error", {
          detail: { conversationId, message: "Chat run aborted by user", code: "aborted" },
        }),
      );
    });

    // Then the HTTP request rejects with a 409 carrying server-resolved
    // attachment paths. The bubble must still pick them up.
    await act(async () => {
      rejectSend!(
        new ApiError("Chat run aborted by user", 409, {
          code: "aborted",
          sessionId: "sess-race-1",
          conversationId,
          attachments: [
            {
              name: "plan.md",
              mimeType: "text/markdown",
              size: 12,
              path: "storage/chat/s1/plan.md",
            },
          ],
        }),
      );
      await sendPromise;
    });

    const userMessage = result.current.messages.find((m) => m.role === "user");
    expect(userMessage?.attachments?.[0]).toEqual(
      expect.objectContaining({
        name: "plan.md",
        path: "storage/chat/s1/plan.md",
      }),
    );
    expect(result.current.chatErrorCode).toBe("aborted");
  });

  it("appends assistantMessage when chat:error races ahead of the 409 abort body", async () => {
    let rejectSend: ((reason?: unknown) => void) | null = null;
    mockSendChatMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );

    const { result } = renderHook(() => useChat("p-1"));

    let sendPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("question");
    });
    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));

    const conversationId = mockSendChatMessage.mock.calls[0][0].conversationId as string;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("chat:error", {
          detail: { conversationId, message: "Chat run aborted by user", code: "aborted" },
        }),
      );
    });

    await act(async () => {
      rejectSend!(
        new ApiError("Chat run aborted by user", 409, {
          code: "aborted",
          sessionId: "sess-race-assistant-1",
          conversationId,
          assistantMessage: "half-written answer",
        }),
      );
      await sendPromise;
    });

    expect(result.current.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "half-written answer" },
    ]);
    expect(result.current.chatErrorCode).toBe("aborted");
    expect(result.current.isStreaming).toBe(false);
  });

  it("toggles explore mode", () => {
    const { result } = renderHook(() => useChat("p-1"));

    expect(result.current.explore).toBe(false);

    act(() => {
      result.current.setExplore(true);
    });

    expect(result.current.explore).toBe(true);
  });
});
