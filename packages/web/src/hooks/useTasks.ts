import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskComment,
  CreateTaskCommentInput,
} from "@aif/shared/browser";
import { api } from "../lib/api.js";

export function useTasks(projectId: string | null) {
  return useQuery<Task[]>({
    queryKey: ["tasks", projectId],
    queryFn: () => api.listTasks(projectId ?? undefined),
    enabled: !!projectId,
  });
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

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.createTask(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      api.updateTask(id, input),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useTaskEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, event }: { id: string; event: TaskEvent }) =>
      api.taskEvent(id, event),
    // Optimistic update
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["tasks"] });
      const previous = queryClient.getQueryData<Task[]>(["tasks"]);
      const previousTask = queryClient.getQueryData<Task>(["task", id]);

      return { previous, previousTask };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["tasks"], context.previous);
      }
      if (context?.previousTask) {
        queryClient.setQueryData(["task", context.previousTask.id], context.previousTask);
      }
    },
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useSyncTaskPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.syncTaskPlan(id),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
}
