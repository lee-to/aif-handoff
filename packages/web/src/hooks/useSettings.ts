import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
}

export function useProjectDefaults(projectId: string | null) {
  return useQuery({
    queryKey: ["projectDefaults", projectId],
    queryFn: () => api.getProjectDefaults(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}
