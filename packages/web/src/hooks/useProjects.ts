import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, CreateProjectInput } from "@aif/shared/browser";
import { api } from "../lib/api.js";

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    // Projects are critical bootstrap data — keep retrying until the API is reachable.
    // Prevents empty UI when the page loads before the API is fully ready (e.g. docker restart).
    retry: true,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15_000),
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

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
