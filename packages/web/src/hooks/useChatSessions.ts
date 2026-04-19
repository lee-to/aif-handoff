import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatSession, ChatSessionMessage } from "@aif/shared/browser";
import { api } from "@/lib/api";

export function useChatSessions(projectId: string | null) {
  const queryClient = useQueryClient();
  const [activeSessionScope, setActiveSessionScope] = useState<{
    projectId: string | null;
    sessionId: string | null;
  }>({
    projectId: null,
    sessionId: null,
  });
  // When true, user explicitly started a new chat - don't auto-select
  const [newChatScopeProjectId, setNewChatScopeProjectId] = useState<string | null>(null);

  const sessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["chatSessions", projectId],
    queryFn: () => api.listChatSessions(projectId!),
    enabled: !!projectId,
    staleTime: 2_000,
  });

  const activeSessionId =
    activeSessionScope.projectId === projectId ? activeSessionScope.sessionId : null;
  const newChatMode = newChatScopeProjectId === projectId;

  // Auto-select the most recent session when sessions load and none is active
  const resolvedSessionId =
    activeSessionId ?? (newChatMode ? null : (sessionsQuery.data?.[0]?.id ?? null));

  // Pin the auto-selected session so it doesn't shift when the sessions list refetches
  const pinActiveSession = useCallback(() => {
    if (!activeSessionId && resolvedSessionId) {
      setActiveSessionScope({ projectId, sessionId: resolvedSessionId });
    }
  }, [activeSessionId, projectId, resolvedSessionId]);

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
      setNewChatScopeProjectId(null);
      setActiveSessionScope({ projectId, sessionId: session.id });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteChatSession(id),
    onSuccess: (_data, deletedId) => {
      console.debug("[useChatSessions] Deleted session %s", deletedId);
      queryClient.invalidateQueries({ queryKey: ["chatSessions", projectId] });
      if (activeSessionId === deletedId) {
        const remaining = sessionsQuery.data?.filter((s) => s.id !== deletedId) ?? [];
        setActiveSessionScope({ projectId, sessionId: remaining[0]?.id ?? null });
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
      const session = sessionsQuery.data?.find((item) => item.id === sessionId);
      return api.getChatSessionMessages(sessionId, {
        projectId,
        runtimeProfileId: session?.runtimeProfileId ?? null,
      });
    },
    [projectId, sessionsQuery.data],
  );

  const selectSession = useCallback(
    (id: string) => {
      setNewChatScopeProjectId(null);
      setActiveSessionScope({ projectId, sessionId: id });
    },
    [projectId],
  );

  const clearActiveSession = useCallback(() => {
    setNewChatScopeProjectId(projectId);
    setActiveSessionScope({ projectId, sessionId: null });
  }, [projectId]);

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    activeSessionId: resolvedSessionId,
    setActiveSessionId: selectSession,
    pinActiveSession,
    clearActiveSession,
    createSession,
    deleteSession,
    renameSession,
    loadSessionMessages,
  };
}
