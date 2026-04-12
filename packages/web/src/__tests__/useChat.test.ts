import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockSendChatMessage = vi.fn();
const mockGetChatSessionMessages = vi.fn();
const mockGetWsClientId = vi.fn();
const WS_CLIENT_ID_WAIT_TIMEOUT_MS = 500;

vi.mock("@/lib/api", () => ({
  api: {
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
    getChatSessionMessages: (...args: unknown[]) => mockGetChatSessionMessages(...args),
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

  it("toggles explore mode", () => {
    const { result } = renderHook(() => useChat("p-1"));

    expect(result.current.explore).toBe(false);

    act(() => {
      result.current.setExplore(true);
    });

    expect(result.current.explore).toBe(true);
  });
});
