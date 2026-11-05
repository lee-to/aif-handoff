import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadObjectiveStatus, ThreadStatus, ThreadWorkspace } from "@aif/shared/browser";
import { api } from "@/lib/api";

export function useThreadWorkspace(threadId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = ["threadWorkspace", threadId] as const;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["chatSessions"] });
  };
  const query = useQuery<ThreadWorkspace>({
    queryKey,
    queryFn: () => api.getThreadWorkspace(threadId!),
    enabled: Boolean(threadId),
  });
  const createObjective = useMutation({
    mutationKey: [...queryKey, "createObjective"],
    mutationFn: (input: { title: string; required?: boolean }) =>
      api.createThreadObjective(threadId!, input),
    onSuccess: refresh,
  });
  const updateObjective = useMutation({
    mutationKey: [...queryKey, "updateObjective"],
    mutationFn: (input: {
      objectiveId: string;
      status?: ThreadObjectiveStatus;
      dropReason?: string | null;
    }) => api.updateThreadObjective(threadId!, input.objectiveId, input),
    onSuccess: refresh,
  });
  const linkTask = useMutation({
    mutationKey: [...queryKey, "linkTask"],
    mutationFn: (input: { taskId: string; objectiveId?: string | null }) =>
      api.linkTaskToThread(threadId!, input.taskId, input.objectiveId),
    onSuccess: (workspace) => {
      queryClient.setQueryData(["threadWorkspace", workspace.thread.id], workspace);
    },
  });
  const unlinkTask = useMutation({
    mutationKey: [...queryKey, "unlinkTask"],
    mutationFn: (taskId: string) => api.unlinkTaskFromThread(threadId!, taskId),
    onSuccess: refresh,
  });
  const updateStatus = useMutation({
    mutationKey: [...queryKey, "updateStatus"],
    mutationFn: (status: ThreadStatus) => api.updateChatSession(threadId!, { status }),
    onSuccess: refresh,
  });
  const error =
    query.error ??
    createObjective.error ??
    updateObjective.error ??
    linkTask.error ??
    unlinkTask.error ??
    updateStatus.error;

  return {
    workspace: query.data,
    isLoading: query.isLoading,
    isSaving:
      createObjective.isPending ||
      updateObjective.isPending ||
      linkTask.isPending ||
      unlinkTask.isPending ||
      updateStatus.isPending,
    error: error instanceof Error ? error.message : null,
    createObjective: createObjective.mutateAsync,
    updateObjective: updateObjective.mutateAsync,
    linkTask: linkTask.mutateAsync,
    unlinkTask: unlinkTask.mutateAsync,
    updateStatus: updateStatus.mutateAsync,
  };
}
