import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateParticipantInput,
  ResetParticipantPasswordInput,
  UpdateParticipantInput,
} from "@aif/shared/browser";
import { api } from "@/lib/api";

export const PARTICIPANTS_QUERY_KEY = ["participants"] as const;

export function useParticipants(enabled = true) {
  return useQuery({
    queryKey: PARTICIPANTS_QUERY_KEY,
    queryFn: () => api.listParticipants(true),
    enabled,
  });
}

export function useCreateParticipant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateParticipantInput) => api.createParticipant(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARTICIPANTS_QUERY_KEY }),
  });
}

export function useUpdateParticipant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateParticipantInput }) =>
      api.updateParticipant(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARTICIPANTS_QUERY_KEY }),
  });
}

export function useDeactivateParticipant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deactivateParticipant(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARTICIPANTS_QUERY_KEY }),
  });
}

export function useResetParticipantPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ResetParticipantPasswordInput }) =>
      api.resetParticipantPassword(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARTICIPANTS_QUERY_KEY }),
  });
}
