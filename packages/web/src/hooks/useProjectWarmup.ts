import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const projectWarmupQueryKey = (projectId: string | null) => ["projectWarmup", projectId];

export function invalidateProjectWarmupQueries(
  queryClient: QueryClient,
  projectId?: string | null,
) {
  if (projectId) {
    queryClient.invalidateQueries({ queryKey: projectWarmupQueryKey(projectId) });
    return;
  }
  queryClient.invalidateQueries({ queryKey: ["projectWarmup"] });
}

export function useProjectWarmup(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: projectWarmupQueryKey(projectId),
    queryFn: () => api.getProjectWarmup(projectId!),
    enabled: Boolean(projectId) && enabled,
    staleTime: 15_000,
  });
}

export function useCreateProjectWarmup(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { ttlSeconds?: number }) => api.createProjectWarmup(projectId!, input),
    onSuccess: () => {
      invalidateProjectWarmupQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useClearProjectWarmup(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearProjectWarmup(projectId!),
    onSuccess: () => {
      invalidateProjectWarmupQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
