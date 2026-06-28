import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  Task,
  TaskListItem,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskEventInput,
  TaskComment,
  CreateTaskCommentInput,
} from "@aif/shared/browser";
import { api } from "../lib/api.js";

export function useTasks(projectId: string | null) {
  return useQuery<TaskListItem[]>({
    queryKey: ["tasks", projectId],
    queryFn: () => api.listTasks(projectId!),
    enabled: !!projectId,
  });
}

/**
 * Fetch the lightweight task list for every project in parallel.
 *
 * The task list contract requires a `projectId`, so the no-project overview
 * screen (and aggregate header metrics) cannot use a single "load all" call.
 * Until a dedicated aggregate endpoint exists, we fan out one scoped request
 * per project and flatten the results here.
 *
 * Returns the merged task list **and** a loading flag derived from query
 * state (not from data presence), so that projects with zero tasks still
 * resolve to a non-loading state.
 */
export function useAllProjectTasks(projectIds: string[]): {
  tasks: TaskListItem[];
  isLoading: boolean;
} {
  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["tasks", projectId] as const,
      queryFn: () => api.listTasks(projectId),
    })),
  });
  const tasks: TaskListItem[] = [];
  for (const result of results) {
    if (result.data) {
      for (const task of result.data) {
        tasks.push(task);
      }
    }
  }
  // Loading is derived from query state, NOT from data presence: a project
  // with zero tasks resolves successfully to `[]`, which must read as
  // "loaded, empty" rather than "still loading".
  const isLoading =
    projectIds.length > 0 && results.some((result) => result.isLoading || result.isFetching);
  return { tasks, isLoading };
}

function invalidateTaskCollections(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
