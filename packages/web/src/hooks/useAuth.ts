import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthSessionState } from "@aif/shared/browser";
import { api, onAuthenticationRequired } from "@/lib/api";

export const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;

function unauthenticatedSession(current?: AuthSessionState): AuthSessionState {
  return {
    participantsModeEnabled: current?.participantsModeEnabled ?? true,
    authenticated: false,
    participant: null,
    csrfToken: null,
    expiresAt: null,
  };
}

export function useAuth() {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: () => api.getAuthSession(),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });

  const clearParticipantScopedQueries = useCallback(() => {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== AUTH_SESSION_QUERY_KEY[0],
    });
  }, [queryClient]);

  useEffect(
    () =>
      onAuthenticationRequired(() => {
        const current = queryClient.getQueryData<AuthSessionState>(AUTH_SESSION_QUERY_KEY);
        clearParticipantScopedQueries();
        queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, unauthenticatedSession(current));
        void queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
      }),
    [clearParticipantScopedQueries, queryClient],
  );

  const loginMutation = useMutation({
    mutationFn: (input: { username: string; password: string }) => api.login(input),
    onSuccess: (session) => {
      clearParticipantScopedQueries();
      queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, session);
      console.info("[auth] Login completed", {
        participantId: session.participant?.id ?? null,
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onMutate: () => ({
      participantId:
        queryClient.getQueryData<AuthSessionState>(AUTH_SESSION_QUERY_KEY)?.participant?.id ?? null,
    }),
    onSuccess: (_response, _variables, context) => {
      const current = queryClient.getQueryData<AuthSessionState>(AUTH_SESSION_QUERY_KEY);
      clearParticipantScopedQueries();
      queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, unauthenticatedSession(current));
      console.info("[auth] Logout completed", {
        participantId: context?.participantId ?? null,
      });
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.changeParticipantPassword(input),
    onSuccess: () => {
      console.info("[auth] Password change completed", {
        participantId:
          queryClient.getQueryData<AuthSessionState>(AUTH_SESSION_QUERY_KEY)?.participant?.id ??
          null,
      });
    },
  });

  return {
    session: sessionQuery.data,
    isLoading: sessionQuery.isLoading,
    isError: sessionQuery.isError,
    error: sessionQuery.error,
    refetch: sessionQuery.refetch,
    login: loginMutation.mutateAsync,
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error,
    resetLoginError: loginMutation.reset,
    logout: logoutMutation.mutateAsync,
    isLoggingOut: logoutMutation.isPending,
    changePassword: changePasswordMutation.mutateAsync,
    isChangingPassword: changePasswordMutation.isPending,
  };
}
