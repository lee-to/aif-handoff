import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, CreateProjectInput } from "@aif/shared/browser";
import { api } from "../lib/api.js";

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: api.listProjects,
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
