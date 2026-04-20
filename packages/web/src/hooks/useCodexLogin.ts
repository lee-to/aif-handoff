import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const CAPABILITIES_KEY = ["codex-login", "capabilities"] as const;
const STATUS_KEY = ["codex-login", "status"] as const;

export function useCodexLoginCapabilities() {
  return useQuery({
    queryKey: CAPABILITIES_KEY,
    queryFn: () => api.getCodexLoginCapabilities(),
    staleTime: 60_000,
  });
}

export function useCodexLoginStatus(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.getCodexLoginStatus(),
    enabled,
    refetchInterval: enabled ? 1_000 : false,
  });
}

export function useStartCodexLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startCodexLogin(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useSubmitCodexCallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.submitCodexCallback(url),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useCancelCodexLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelCodexLogin(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
