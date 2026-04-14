import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ChatMessage,
  ChatAttachment,
  ChatMessageAttachment,
  ChatStreamTokenPayload,
  ChatDonePayload,
  ChatErrorPayload,
} from "@aif/shared/browser";
import { api } from "@/lib/api";
import { getWsClientId } from "./useWebSocket";

interface SessionStreamState {
  conversationId: string;
  accumulator: string;
  messages: ChatMessage[];
  errorHandled: boolean;
}

const WS_CLIENT_ID_WAIT_TIMEOUT_MS = 500;
const WS_CLIENT_ID_POLL_INTERVAL_MS = 50;

async function waitForWsClientId(
  timeoutMs = WS_CLIENT_ID_WAIT_TIMEOUT_MS,
  pollIntervalMs = WS_CLIENT_ID_POLL_INTERVAL_MS,
): Promise<string | null> {
  const existing = getWsClientId();
  if (existing) return existing;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const clientId = getWsClientId();
    if (clientId) return clientId;
  }

  return getWsClientId();
}

export function useChat(
  projectId: string | null,
  sessionId: string | null = null,
  taskId: string | null = null,
  onSessionResolved?: (sessionId: string) => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [explore, setExplore] = useState(false);
  const [chatErrorCode, setChatErrorCode] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  // Conversation id of the most recently dispatched message — used by abortStream().
  const currentConversationIdRef = useRef<string | null>(null);
  // Per-session streaming state: conversationId → streamKey (sessionId or conversationId)
  const activeStreamsRef = useRef<Map<string, string>>(new Map());
  // Per-session stream data: streamKey → state
  const sessionStreamsRef = useRef<Map<string, SessionStreamState>>(new Map());
  // Track conversationId used when no session exists (for matching events)
  const conversationIdForNoSession = useRef<string | null>(null);
  // Deduplicate WS and HTTP error handling for the same conversation.
  const handledErrorConversationsRef = useRef<Set<string>>(new Set());
  // Coordinate HTTP fallback and forced-stop timeouts per conversation.
  const fallbackTimersRef = useRef<Map<string, number>>(new Map());
  const forcedStopTimersRef = useRef<Map<string, number>>(new Map());

  const clearConversationTimers = useCallback((conversationId: string) => {
    const fallbackTimer = fallbackTimersRef.current.get(conversationId);
    if (fallbackTimer !== undefined) {
      window.clearTimeout(fallbackTimer);
      fallbackTimersRef.current.delete(conversationId);
    }

    const forcedStopTimer = forcedStopTimersRef.current.get(conversationId);
    if (forcedStopTimer !== undefined) {
      window.clearTimeout(forcedStopTimer);
      forcedStopTimersRef.current.delete(conversationId);
    }
  }, []);

  const clearAllConversationTimers = useCallback(() => {
    const conversationIds = new Set([
      ...fallbackTimersRef.current.keys(),
      ...forcedStopTimersRef.current.keys(),
    ]);
    for (const conversationId of conversationIds) {
      clearConversationTimers(conversationId);
    }
  }, [clearConversationTimers]);

  // Check if a specific session is currently streaming
  const isSessionStreaming = useCallback((sid: string | null) => {
    if (!sid) return false;
    for (const [, streamSid] of activeStreamsRef.current) {
      if (streamSid === sid) return true;
    }
    return false;
  }, []);

  const prevSessionIdRef = useRef<string | null>(null);
  // Load messages when sessionId changes
  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      if (prevSessionId !== null) {
        console.debug("[useChat] Session cleared, resetting messages");
        currentSessionIdRef.current = null;
        queueMicrotask(() => {
          setMessages([]);
          setChatErrorCode(null);
          setIsStreaming(false);
        });
      }
      return;
    }

    if (sessionId === currentSessionIdRef.current) return;

    currentSessionIdRef.current = sessionId;

    // If this session is actively streaming, restore its in-flight messages
    const streamState = sessionStreamsRef.current.get(sessionId);
    if (streamState) {
      console.debug("[useChat] Restoring streaming session %s", sessionId);
      setMessages(streamState.messages);
      setIsStreaming(true);
      setChatErrorCode(null);
      return;
    }

    // Otherwise load from server
    queueMicrotask(() => setIsStreaming(false));
    console.debug("[useChat] Loading session messages sessionId=%s", sessionId);

    api
      .getChatSessionMessages(sessionId)
      .then((msgs) => {
        if (currentSessionIdRef.current !== sessionId) return;
        if (isSessionStreaming(sessionId)) {
          console.debug("[useChat] Skipping session load — streaming in progress");
          return;
        }
        console.debug("[useChat] Session changed, loaded %d messages", msgs.length);
        setMessages(
          msgs.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
          })),
        );
        setChatErrorCode(null);
      })
      .catch((err) => {
        console.error("[useChat] Failed to load session messages:", err);
      });
  }, [sessionId, isSessionStreaming]);

  // Listen for chat stream events dispatched by useWebSocket
  useEffect(() => {
    // Check if a stream belongs to the currently viewed session
    const isCurrentStream = (streamKey: string) =>
      currentSessionIdRef.current === streamKey ||
      (!currentSessionIdRef.current && streamKey === conversationIdForNoSession.current);

    const handleToken = (e: Event) => {
      const { conversationId, token } = (e as CustomEvent<ChatStreamTokenPayload>).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      clearConversationTimers(conversationId);

      const state = sessionStreamsRef.current.get(streamKey);
      if (!state) return;

      state.accumulator += token;
      const accumulated = state.accumulator;

      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant") {
        state.messages = [
          ...state.messages.slice(0, -1),
          { role: "assistant", content: accumulated },
        ];
      } else {
        state.messages = [...state.messages, { role: "assistant", content: accumulated }];
      }

      if (isCurrentStream(streamKey)) {
        setMessages(state.messages);
      }
    };

    const handleDone = (e: Event) => {
      const { conversationId } = (e as CustomEvent<ChatDonePayload>).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      console.debug("[useChat] Stream done for %s conversation %s", streamKey, conversationId);
      clearConversationTimers(conversationId);
      activeStreamsRef.current.delete(conversationId);
      sessionStreamsRef.current.delete(streamKey);

      if (isCurrentStream(streamKey)) {
        setIsStreaming(false);
      }
      handledErrorConversationsRef.current.delete(conversationId);
    };

    const handleError = (e: Event) => {
      const { conversationId, message, code } = (e as CustomEvent<ChatErrorPayload>).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      const state = sessionStreamsRef.current.get(streamKey);
      if (state) state.errorHandled = true;
      handledErrorConversationsRef.current.add(conversationId);

      console.debug("[useChat] Stream error for %s", streamKey);
      clearConversationTimers(conversationId);
      activeStreamsRef.current.delete(conversationId);
      sessionStreamsRef.current.delete(streamKey);

      if (isCurrentStream(streamKey)) {
        setIsStreaming(false);
        setChatErrorCode(code ?? null);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: message || "Chat request failed" },
        ]);
      }
    };

    window.addEventListener("chat:token", handleToken);
    window.addEventListener("chat:done", handleDone);
    window.addEventListener("chat:error", handleError);
    return () => {
      window.removeEventListener("chat:token", handleToken);
      window.removeEventListener("chat:done", handleDone);
      window.removeEventListener("chat:error", handleError);
      clearAllConversationTimers();
    };
  }, [clearAllConversationTimers, clearConversationTimers]);

  const sendMessage = useCallback(
    async (text: string, attachments?: ChatAttachment[], forceNewSession?: boolean) => {
      if (!projectId || !text.trim() || isStreaming) return;

      const clientId = await waitForWsClientId();
      if (!clientId) {
        console.debug("[useChat] No clientId available, proceeding with HTTP fallback");
      }

      // When runtime changed, force a new session instead of resuming the old one
      if (forceNewSession) {
        currentSessionIdRef.current = null;
      }

      const newConversationId = crypto.randomUUID();
      const effectiveSessionId = forceNewSession
        ? null
        : (sessionId ?? currentSessionIdRef.current);
      // Use sessionId or conversationId as stream key (for sessions not yet created)
      const streamKey = effectiveSessionId ?? newConversationId;

      const messageAttachments: ChatMessageAttachment[] | undefined = attachments?.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      }));
      const userMessage: ChatMessage = {
        role: "user",
        content: text.trim(),
        ...(messageAttachments?.length ? { attachments: messageAttachments } : {}),
      };
      // When forcing a new session, start fresh — don't carry over old messages
      const newMessages = forceNewSession ? [userMessage] : [...messages, userMessage];

      // Register active stream
      currentConversationIdRef.current = newConversationId;
      if (!effectiveSessionId) {
        conversationIdForNoSession.current = newConversationId;
      }
      activeStreamsRef.current.set(newConversationId, streamKey);
      sessionStreamsRef.current.set(streamKey, {
        conversationId: newConversationId,
        accumulator: "",
        messages: newMessages,
        errorHandled: false,
      });

      setMessages(newMessages);
      setIsStreaming(true);
      setChatErrorCode(null);
      if (explore) setExplore(false);

      console.debug("[useChat] Sending message:", {
        projectId,
        conversationId: newConversationId,
        sessionId: effectiveSessionId,
        explore,
      });

      try {
        const result = await api.sendChatMessage({
          projectId,
          message: text.trim(),
          conversationId: newConversationId,
          sessionId: effectiveSessionId ?? undefined,
          explore,
          ...(clientId ? { clientId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(attachments?.length ? { attachments } : {}),
        });

        if (result.sessionId) {
          currentSessionIdRef.current = result.sessionId;

          if (streamKey !== result.sessionId) {
            const state = sessionStreamsRef.current.get(streamKey);
            if (state) {
              sessionStreamsRef.current.delete(streamKey);
              sessionStreamsRef.current.set(result.sessionId, state);
            }
            activeStreamsRef.current.set(newConversationId, result.sessionId);
          }

          if (result.sessionId !== effectiveSessionId) {
            onSessionResolved?.(result.sessionId);
          }
          window.dispatchEvent(
            new CustomEvent("chat:session_created", { detail: { id: result.sessionId } }),
          );
        }

        // Update user message attachments with server-resolved paths (for download links)
        if (result.attachments?.length) {
          setMessages((prev) =>
            prev.map((m) => (m === userMessage ? { ...m, attachments: result.attachments } : m)),
          );
          const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
          const state = sessionStreamsRef.current.get(activeStreamKey);
          if (state) {
            // Also update in-flight stream state
            state.messages = state.messages.map((m) =>
              m.role === "user" &&
              m.content === userMessage.content &&
              m.attachments &&
              !m.attachments[0]?.path
                ? { ...m, attachments: result.attachments }
                : m,
            );
          }
        }

        const assistantMessage = result.assistantMessage;
        if (assistantMessage?.trim()) {
          const fallbackTimer = window.setTimeout(() => {
            const activeStreamKey = activeStreamsRef.current.get(newConversationId);
            if (!activeStreamKey) {
              clearConversationTimers(newConversationId);
              return;
            }

            const state = sessionStreamsRef.current.get(activeStreamKey);
            if (!state) {
              clearConversationTimers(newConversationId);
              return;
            }

            if (state.accumulator.length > 0) {
              clearConversationTimers(newConversationId);
              return;
            }

            console.debug(
              "[useChat] Applying HTTP assistant fallback for conversation %s",
              newConversationId,
            );
            clearConversationTimers(newConversationId);
            state.messages = [...state.messages, { role: "assistant", content: assistantMessage }];
            setMessages(state.messages);
            activeStreamsRef.current.delete(newConversationId);
            sessionStreamsRef.current.delete(activeStreamKey);
            setIsStreaming(false);
          }, 100);
          fallbackTimersRef.current.set(newConversationId, fallbackTimer);
        }

        const forcedStopTimer = window.setTimeout(() => {
          const activeStreamKey = activeStreamsRef.current.get(newConversationId);
          if (!activeStreamKey) {
            clearConversationTimers(newConversationId);
            return;
          }

          const state = sessionStreamsRef.current.get(activeStreamKey);
          if (state?.accumulator.length) {
            clearConversationTimers(newConversationId);
            return;
          }

          console.debug("[useChat] Stream still active after HTTP — forcing stop");
          clearConversationTimers(newConversationId);
          activeStreamsRef.current.delete(newConversationId);
          sessionStreamsRef.current.delete(activeStreamKey);
          setIsStreaming(false);
        }, 500);
        forcedStopTimersRef.current.set(newConversationId, forcedStopTimer);
      } catch (err) {
        console.error("[useChat] Failed to send message:", err);
        clearConversationTimers(newConversationId);
        const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
        activeStreamsRef.current.delete(newConversationId);
        const errorHandled = sessionStreamsRef.current.get(activeStreamKey)?.errorHandled ?? false;
        sessionStreamsRef.current.delete(activeStreamKey);
        setIsStreaming(false);
        const wsHandled = handledErrorConversationsRef.current.has(newConversationId);
        if (!errorHandled && !wsHandled) {
          const message =
            err instanceof Error ? err.message : "Failed to get a response. Please try again.";
          setChatErrorCode(null);
          setMessages((prev) => [...prev, { role: "assistant", content: message }]);
        }
        handledErrorConversationsRef.current.delete(newConversationId);
      }
    },
    [
      projectId,
      sessionId,
      messages,
      isStreaming,
      explore,
      taskId,
      onSessionResolved,
      clearConversationTimers,
    ],
  );

  const abortStream = useCallback(async () => {
    const conversationId = currentConversationIdRef.current;
    if (!conversationId) return;
    console.debug("[useChat] aborting conversation %s", conversationId);
    try {
      await api.abortChat(conversationId);
    } catch (err) {
      console.warn("[useChat] abort request failed", err);
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setChatErrorCode(null);
  }, []);

  const newSession = useCallback(() => {
    setMessages([]);
    currentSessionIdRef.current = null;
    setChatErrorCode(null);
  }, []);

  return {
    messages,
    isStreaming,
    chatErrorCode,
    explore,
    setExplore,
    sendMessage,
    abortStream,
    clearMessages,
    newSession,
  };
}
