import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, CreateProjectInput } from "@aif/shared/browser";
import { api, ApiError } from "../lib/api.js";

const MAX_PROJECTS_RETRIES = 8;

export function shouldRetryProjects(failureCount: number, error: unknown): boolean {
  // Don't retry client errors (auth/not-found/bad request) — they won't resolve by waiting.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_PROJECTS_RETRIES;
}

export function projectsRetryDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 15_000);
}

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    // Projects are bootstrap data — retry transient failures with backoff so the UI
    // recovers after an API restart, but surface 4xx errors instead of spinning forever.
    retry: shouldRetryProjects,
    retryDelay: projectsRetryDelay,
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateProjectInput }) =>
      api.updateProject(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime"] });
    },
  });
}

export function useAutoQueueMode(projectId: string | null) {
  return useQuery<{ enabled: boolean }>({
    queryKey: ["autoQueueMode", projectId],
    queryFn: () => api.getAutoQueueMode(projectId!),
    enabled: Boolean(projectId),
  });
}

export function useSetAutoQueueMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setAutoQueueMode(id, enabled),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["autoQueueMode", id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
