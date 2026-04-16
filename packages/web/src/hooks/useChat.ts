import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ChatMessage,
  ChatAttachment,
  ChatMessageAttachment,
  ChatStreamTokenPayload,
  ChatDonePayload,
  ChatErrorPayload,
} from "@aif/shared/browser";
import { api, ApiError } from "@/lib/api";
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

  // True when `streamKey` belongs to the session the user is currently viewing.
  // Any `setIsStreaming` / `setChatErrorCode` / `setMessages` call that ends a
  // run must be gated by this — otherwise a background session terminating
  // would wipe the Stop button / banner / transcript of an unrelated session
  // the user has already switched to.
  const isCurrentStream = useCallback((streamKey: string) => {
    return (
      currentSessionIdRef.current === streamKey ||
      (!currentSessionIdRef.current && streamKey === conversationIdForNoSession.current)
    );
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
        // User-initiated aborts surface as a banner via chatErrorCode, not a
        // phantom assistant bubble. The bubble was misleading because only
        // partial streamed text (if any) is persisted to DB — the "Chat run
        // aborted by user" text disappeared after reload, and the partial
        // reply took its place. Any partial assistant content is already
        // visible in the transcript via handleToken.
        if (code !== "aborted") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: message || "Chat request failed" },
          ]);
        }
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
  }, [clearAllConversationTimers, clearConversationTimers, isCurrentStream]);

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
          const resolvedId = result.sessionId;
          // Move stream-scoped state to the resolved key regardless of which
          // session the user is viewing — WS events still need to match.
          if (streamKey !== resolvedId) {
            const state = sessionStreamsRef.current.get(streamKey);
            if (state) {
              sessionStreamsRef.current.delete(streamKey);
              sessionStreamsRef.current.set(resolvedId, state);
            }
            activeStreamsRef.current.set(newConversationId, resolvedId);
          }

          // Only rebind the viewed session to the resolved id when the user is
          // still on this stream. Otherwise a background run finishing would
          // silently yank their view back to the originating session.
          if (isCurrentStream(streamKey)) {
            currentSessionIdRef.current = resolvedId;
            if (resolvedId !== effectiveSessionId) {
              onSessionResolved?.(resolvedId);
            }
          }
          // Sidebar notification is view-agnostic.
          window.dispatchEvent(
            new CustomEvent("chat:session_created", { detail: { id: resolvedId } }),
          );
        }

        // Update user message attachments with server-resolved paths (for download links)
        if (result.attachments?.length) {
          const resolvedAttachments = result.attachments;
          const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
          const state = sessionStreamsRef.current.get(activeStreamKey);
          if (state) {
            // Also update in-flight stream state so restoring the session
            // after a switch-away keeps the upgraded attachments.
            state.messages = state.messages.map((m) =>
              m.role === "user" &&
              m.content === userMessage.content &&
              m.attachments &&
              !m.attachments[0]?.path
                ? { ...m, attachments: resolvedAttachments }
                : m,
            );
          }
          if (isCurrentStream(activeStreamKey)) {
            setMessages((prev) =>
              prev.map((m) => (m === userMessage ? { ...m, attachments: resolvedAttachments } : m)),
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
            activeStreamsRef.current.delete(newConversationId);
            sessionStreamsRef.current.delete(activeStreamKey);
            // Only mutate UI state when the viewed session owns this stream.
            // Otherwise a background session finishing would set the active
            // session's transcript to someone else's messages.
            if (isCurrentStream(activeStreamKey)) {
              setMessages(state.messages);
              setIsStreaming(false);
            }
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
          if (isCurrentStream(activeStreamKey)) {
            setIsStreaming(false);
          }
        }, 500);
        forcedStopTimersRef.current.set(newConversationId, forcedStopTimer);
      } catch (err) {
        console.error("[useChat] Failed to send message:", err);
        clearConversationTimers(newConversationId);

        const abortData =
          err instanceof ApiError && err.status === 409
            ? (err.data as {
                code?: string;
                sessionId?: string | null;
                assistantMessage?: string | null;
                attachments?: ChatMessageAttachment[];
              } | null)
            : null;
        const isAbortedError = abortData?.code === "aborted";

        // If the server aborted the run but already created a DB session, promote
        // it so the fresh "new chat" doesn't lose its thread in the sidebar.
        // Only switch the viewed session when the user is still on this stream —
        // otherwise a background abort would yank them away from the session
        // they're currently reading.
        if (isAbortedError && abortData?.sessionId) {
          const resolvedId = abortData.sessionId;
          const shouldPromoteView = isCurrentStream(streamKey);
          if (streamKey !== resolvedId) {
            const state = sessionStreamsRef.current.get(streamKey);
            if (state) {
              sessionStreamsRef.current.delete(streamKey);
              sessionStreamsRef.current.set(resolvedId, state);
            }
            activeStreamsRef.current.set(newConversationId, resolvedId);
          }
          if (shouldPromoteView) {
            currentSessionIdRef.current = resolvedId;
            if (resolvedId !== effectiveSessionId) {
              onSessionResolved?.(resolvedId);
            }
          }
          // Sidebar update is view-agnostic — always surface the new session.
          window.dispatchEvent(
            new CustomEvent("chat:session_created", { detail: { id: resolvedId } }),
          );
        }

        const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
        const state = sessionStreamsRef.current.get(activeStreamKey);
        const errorHandled = state?.errorHandled ?? false;
        const hasAccumulatedTokens = (state?.accumulator.length ?? 0) > 0;

        // On abort, apply server-resolved data to the stream-scoped state before
        // deleting it. Guards below then decide whether to mirror the changes
        // into React state for the viewed session.
        let patchedUserAttachments: ChatMessageAttachment[] | undefined;
        let appendedPartialAssistant: string | null = null;
        if (isAbortedError && state) {
          if (abortData?.attachments?.length) {
            const resolvedAttachments = abortData.attachments;
            state.messages = state.messages.map((m) =>
              m.role === "user" &&
              m.content === userMessage.content &&
              m.attachments &&
              !m.attachments[0]?.path
                ? { ...m, attachments: resolvedAttachments }
                : m,
            );
            patchedUserAttachments = resolvedAttachments;
          }
          if (
            !hasAccumulatedTokens &&
            typeof abortData?.assistantMessage === "string" &&
            abortData.assistantMessage.trim().length > 0
          ) {
            appendedPartialAssistant = abortData.assistantMessage;
            state.messages = [
              ...state.messages,
              { role: "assistant", content: appendedPartialAssistant },
            ];
          }
        }

        activeStreamsRef.current.delete(newConversationId);
        sessionStreamsRef.current.delete(activeStreamKey);

        const wsHandled = handledErrorConversationsRef.current.has(newConversationId);
        // All UI state mutations below end the run for the viewed session —
        // gate them on isCurrentStream so a background conversation terminating
        // can't hide Stop / flip the banner / inject messages into session B
        // while the user is watching it.
        if (isCurrentStream(activeStreamKey)) {
          if (patchedUserAttachments) {
            const resolved = patchedUserAttachments;
            setMessages((prev) =>
              prev.map((m) => (m === userMessage ? { ...m, attachments: resolved } : m)),
            );
          }
          if (appendedPartialAssistant) {
            const partial = appendedPartialAssistant;
            setMessages((prev) => [...prev, { role: "assistant", content: partial }]);
          }
          setIsStreaming(false);
          if (isAbortedError) {
            // Abort is surfaced via the banner only — no phantom bubble.
            setChatErrorCode("aborted");
          } else if (!errorHandled && !wsHandled) {
            const message =
              err instanceof Error ? err.message : "Failed to get a response. Please try again.";
            setChatErrorCode(null);
            setMessages((prev) => [...prev, { role: "assistant", content: message }]);
          }
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
      isCurrentStream,
    ],
  );

  const abortStream = useCallback(async () => {
    // Pick the conversation whose streamKey matches the currently viewed session
    // (or the pending new-chat conversation), so switching sessions while
    // multiple runs are in flight doesn't abort the wrong one.
    const targetKey = currentSessionIdRef.current ?? conversationIdForNoSession.current;
    if (!targetKey) return;
    let conversationId: string | null = null;
    for (const [convId, streamKey] of activeStreamsRef.current) {
      if (streamKey === targetKey) {
        conversationId = convId;
        break;
      }
    }
    if (!conversationId) return;
    console.debug("[useChat] aborting conversation %s (key=%s)", conversationId, targetKey);
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
