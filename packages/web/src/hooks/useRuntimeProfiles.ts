import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateRuntimeProfileInput, UpdateRuntimeProfileInput } from "@aif/shared/browser";
import { api } from "@/lib/api";

export function useRuntimeProfiles(projectId: string | null, includeGlobal = true) {
  return useQuery({
    queryKey: ["runtimeProfiles", projectId, includeGlobal],
    queryFn: () =>
      api.listRuntimeProfiles({
        ...(projectId ? { projectId } : {}),
        includeGlobal,
        enabledOnly: false,
      }),
    staleTime: 30_000,
  });
}

export function useRuntimes() {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: api.listRuntimes,
    staleTime: 60_000,
  });
}

export function useCreateRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuntimeProfileInput) => api.createRuntimeProfile(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimeProfiles"] });
    },
  });
}

export function useUpdateRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRuntimeProfileInput }) =>
      api.updateRuntimeProfile(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimeProfiles"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime"] });
    },
  });
}

export function useDeleteRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeProfile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimeProfiles"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime"] });
      queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime"] });
    },
  });
}

export function useValidateRuntimeProfile() {
  return useMutation({
    mutationFn: api.validateRuntimeProfile,
  });
}

export function useRuntimeModels() {
  return useMutation({
    mutationFn: api.listRuntimeModels,
  });
}

export function useEffectiveTaskRuntime(taskId: string | null) {
  return useQuery({
    queryKey: ["effectiveTaskRuntime", taskId],
    queryFn: () => api.getEffectiveTaskRuntime(taskId!),
    enabled: Boolean(taskId),
    staleTime: 30_000,
  });
}

export function useEffectiveChatRuntime(projectId: string | null) {
  return useQuery({
    queryKey: ["effectiveChatRuntime", projectId],
    queryFn: () => api.getEffectiveChatRuntime(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}
