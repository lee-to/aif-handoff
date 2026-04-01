import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockSendChatMessage = vi.fn();
const mockGetChatSessionMessages = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
    getChatSessionMessages: (...args: unknown[]) => mockGetChatSessionMessages(...args),
  },
}));

vi.mock("@/hooks/useWebSocket", () => ({
  getWsClientId: () => "test-client-id",
}));

const { useChat } = await import("@/hooks/useChat");

describe("useChat", () => {
  beforeEach(() => {
    mockSendChatMessage.mockReset();
    mockGetChatSessionMessages.mockReset();
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

  it("toggles explore mode", () => {
    const { result } = renderHook(() => useChat("p-1"));

    expect(result.current.explore).toBe(false);

    act(() => {
      result.current.setExplore(true);
    });

    expect(result.current.explore).toBe(true);
  });
});
