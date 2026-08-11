import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  Task,
  TaskListItem,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskEventInput,
  TaskComment,
  CreateTaskCommentInput,
  HandoffTaskInput,
  TaskExecutorHistoryEntry,
} from "@aif/shared/browser";
import { api } from "../lib/api.js";
import { invalidateProjectTaskOverviews } from "./useProjects.js";

export function useTasks(projectId: string | null) {
  return useQuery<TaskListItem[]>({
    queryKey: ["tasks", projectId],
    queryFn: () => api.listTasks(projectId!),
    enabled: !!projectId,
  });
}

function invalidateTaskCollections(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ["tasks"] });
  invalidateProjectTaskOverviews(queryClient);
}

export function useTask(id: string | null) {
  return useQuery<Task>({
    queryKey: ["task", id],
    queryFn: () => api.getTask(id!),
    enabled: !!id,
  });
}

export function useTaskComments(id: string | null) {
  return useQuery<TaskComment[]>({
    queryKey: ["task-comments", id],
    queryFn: () => api.listTaskComments(id!),
    enabled: !!id,
  });
}

export function useTaskExecutorHistory(id: string | null) {
  return useQuery<TaskExecutorHistoryEntry[]>({
    queryKey: ["task-executor-history", id],
    queryFn: () => api.getTaskExecutorHistory(id!),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.createTask(input),
    onSuccess: () => {
      invalidateTaskCollections(queryClient);
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      api.updateTask(id, input),
    onSuccess: (task) => {
      invalidateTaskCollections(queryClient);
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
}

export function useHandoffTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: HandoffTaskInput }) =>
      api.handoffTask(id, input),
    onSuccess: ({ task }) => {
      console.info("[task-ownership] Handoff completed", {
        taskId: task.id,
        executionOwner: task.executionOwner,
        ownershipRevision: task.ownershipRevision,
      });
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["task-executor-history", task.id] });
      invalidateTaskCollections(queryClient);
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: ["task", id] });
      invalidateTaskCollections(queryClient);
    },
  });
}

export function useTaskEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      event,
      deletePlanFile,
      commitOnApprove,
    }: {
      id: string;
      event: TaskEvent;
      deletePlanFile?: TaskEventInput["deletePlanFile"];
      commitOnApprove?: TaskEventInput["commitOnApprove"];
    }) => api.taskEvent(id, event, { deletePlanFile, commitOnApprove }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["tasks"] });
      const previousTaskLists = queryClient.getQueriesData<TaskListItem[]>({
        queryKey: ["tasks"],
      });
      const previousTask = queryClient.getQueryData<Task>(["task", id]);

      return { previousTaskLists, previousTask };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousTaskLists) {
        for (const [queryKey, taskList] of context.previousTaskLists) {
          queryClient.setQueryData(queryKey, taskList);
        }
      }
      if (context?.previousTask) {
        queryClient.setQueryData(["task", context.previousTask.id], context.previousTask);
      }
    },
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: (_data, _error, vars) => {
      invalidateTaskCollections(queryClient);
      queryClient.invalidateQueries({ queryKey: ["task", vars.id] });
    },
  });
}

export function useCreateTaskComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateTaskCommentInput }) =>
      api.createTaskComment(id, input),
    onSuccess: (comment) => {
      queryClient.invalidateQueries({ queryKey: ["task-comments", comment.taskId] });
    },
  });
}

export function useReorderTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      api.reorderTask(id, position),
    onSettled: () => {
      invalidateTaskCollections(queryClient);
    },
  });
}

export function useSyncTaskPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.syncTaskPlan(id),
    onSuccess: (task) => {
      invalidateTaskCollections(queryClient);
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
}

export function useRunQa(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.runQa(taskId),
    // WS delivers task:updated; explicit invalidation as a fallback for the
    // manual POST path (auto-trigger relies on the WS handler instead).
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
  });
}
