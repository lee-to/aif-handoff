import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CreateRuntimeProfileInput, UpdateRuntimeProfileInput } from "@aif/shared/browser";
import { api } from "@/lib/api";

export function useRuntimeProfiles(projectId: string | null, includeGlobal = true, enabled = true) {
  return useQuery({
    queryKey: ["runtimeProfiles", projectId, includeGlobal],
    queryFn: () =>
      api.listRuntimeProfiles({
        ...(projectId ? { projectId } : {}),
        includeGlobal,
        enabledOnly: false,
      }),
    enabled,
    staleTime: 30_000,
  });
}

export function useProjectRuntimeProfiles(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["runtimeProfiles", "project", projectId],
    queryFn: () =>
      api.listRuntimeProfiles({
        projectId: projectId!,
        enabledOnly: false,
        scope: "project",
      }),
    enabled: Boolean(projectId) && enabled,
    staleTime: 30_000,
  });
}

export function useGlobalRuntimeProfiles(enabled = true) {
  return useQuery({
    queryKey: ["runtimeProfiles", "global"],
    queryFn: () =>
      api.listRuntimeProfiles({
        enabledOnly: false,
        scope: "global",
      }),
    enabled,
    staleTime: 30_000,
  });
}

export function useRuntimes(enabled = true) {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: api.listRuntimes,
    enabled,
    staleTime: 60_000,
  });
}

export function useAppRuntimeDefaults(enabled = true) {
  return useQuery({
    queryKey: ["appRuntimeDefaults"],
    queryFn: api.getAppRuntimeDefaults,
    enabled,
    staleTime: 30_000,
  });
}

function invalidateRuntimeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["runtimeProfiles"] });
  queryClient.invalidateQueries({ queryKey: ["appRuntimeDefaults"] });
  queryClient.invalidateQueries({ queryKey: ["settings"] });
  queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime"] });
  queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime"] });
}

export function useCreateRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuntimeProfileInput) => api.createRuntimeProfile(input),
    onSuccess: () => {
      invalidateRuntimeQueries(queryClient);
    },
  });
}

export function useUpdateRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRuntimeProfileInput }) =>
      api.updateRuntimeProfile(id, input),
    onSuccess: () => {
      invalidateRuntimeQueries(queryClient);
    },
  });
}

export function useDeleteRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeProfile(id),
    onSuccess: () => {
      invalidateRuntimeQueries(queryClient);
    },
  });
}

export function useUpdateAppRuntimeDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateAppRuntimeDefaults,
    onSuccess: () => {
      invalidateRuntimeQueries(queryClient);
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
