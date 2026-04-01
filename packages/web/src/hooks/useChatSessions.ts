import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatSession, ChatSessionMessage } from "@aif/shared/browser";
import { api } from "../lib/api.js";

export function useChatSessions(projectId: string | null) {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // When true, user explicitly started a new chat — don't auto-select
  const newChatModeRef = useRef(false);

  const sessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["chatSessions", projectId],
    queryFn: () => api.listChatSessions(projectId!),
    enabled: !!projectId,
  });

  // Auto-select the most recent session when sessions load and none is active
  const resolvedSessionId = useMemo(() => {
    if (activeSessionId) return activeSessionId;
    if (newChatModeRef.current) return null;
    if (sessionsQuery.data?.length) {
      const latest = sessionsQuery.data[0];
      console.debug("[useChatSessions] Auto-selecting latest session %s", latest.id);
      return latest.id;
    }
    return null;
  }, [sessionsQuery.data, activeSessionId]);

  // Listen for WS events to invalidate sessions
  useEffect(() => {
    const invalidate = () => {
      console.debug("[useChatSessions] Invalidating sessions on WS event");
      queryClient.invalidateQueries({ queryKey: ["chatSessions", projectId] });
    };

    window.addEventListener("chat:session_created", invalidate);
    window.addEventListener("chat:session_deleted", invalidate);
    return () => {
      window.removeEventListener("chat:session_created", invalidate);
      window.removeEventListener("chat:session_deleted", invalidate);
    };
  }, [projectId, queryClient]);

  const createMutation = useMutation({
    mutationFn: (title?: string) => api.createChatSession({ projectId: projectId!, title }),
    onSuccess: (session) => {
      console.debug("[useChatSessions] Created session %s", session.id);
      queryClient.invalidateQueries({ queryKey: ["chatSessions", projectId] });
      setActiveSessionId(session.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteChatSession(id),
    onSuccess: (_data, deletedId) => {
      console.debug("[useChatSessions] Deleted session %s", deletedId);
      queryClient.invalidateQueries({ queryKey: ["chatSessions", projectId] });
      if (activeSessionId === deletedId) {
        const remaining = sessionsQuery.data?.filter((s) => s.id !== deletedId) ?? [];
        setActiveSessionId(remaining[0]?.id ?? null);
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.updateChatSession(id, { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chatSessions", projectId] });
    },
  });

  const createSession = useCallback(
    (title?: string) => createMutation.mutateAsync(title),
    [createMutation],
  );

  const deleteSession = useCallback(
    (id: string) => deleteMutation.mutateAsync(id),
    [deleteMutation],
  );

  const renameSession = useCallback(
    (id: string, title: string) => renameMutation.mutateAsync({ id, title }),
    [renameMutation],
  );

  const loadSessionMessages = useCallback(
    async (sessionId: string): Promise<ChatSessionMessage[]> => {
      console.debug("[useChatSessions] Loading messages for session %s", sessionId);
      return api.getChatSessionMessages(sessionId);
    },
    [],
  );

  const selectSession = useCallback((id: string) => {
    newChatModeRef.current = false;
    setActiveSessionId(id);
  }, []);

  const clearActiveSession = useCallback(() => {
    newChatModeRef.current = true;
    setActiveSessionId(null);
  }, []);

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    activeSessionId: resolvedSessionId,
    setActiveSessionId: selectSession,
    clearActiveSession,
    createSession,
    deleteSession,
    renameSession,
    loadSessionMessages,
  };
}
