import { existsSync, readFileSync } from "node:fs";
import { getCanonicalPlanPath } from "@aif/shared";
import {
  createTask,
  createTaskComment,
  updateTaskComment,
  deleteTask,
  findProjectByTaskId,
  findTaskById,
  listTaskListItems,
  listTaskComments as listComments,
  listTasks,
  persistTaskPlanForTask,
  toCommentResponse,
  toTaskResponse,
  type TaskRow,
  type CommentRow,
  updateTask,
} from "@aif/data";
import type { AuditActor, ExecutionOwner, TaskAssigneeSummary, TaskStatus } from "@aif/shared";

export function toTaskBroadcastPayload(
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    executionOwner?: ExecutionOwner;
    ownershipRevision?: number;
    assignees?: TaskAssigneeSummary[];
  },
  actor?: AuditActor,
) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.executionOwner === undefined ? {} : { executionOwner: task.executionOwner }),
    ...(task.ownershipRevision === undefined ? {} : { ownershipRevision: task.ownershipRevision }),
    ...(task.assignees === undefined ? {} : { assignees: task.assignees }),
    ...(actor === undefined ? {} : { actor }),
  };
}

export function updateTaskPlan(
  taskId: string,
  planText: string | null,
  isFix: boolean,
  planPath?: string,
): void {
  const project = findProjectByTaskId(taskId);
  if (!project) throw new Error("Project not found for task");
  const task = findTaskById(taskId);
  const executionRoot = task?.worktreePath ?? project.rootPath;

  persistTaskPlanForTask({
    taskId,
    planText,
    projectRoot: executionRoot,
    isFix,
    planPath,
    updatedAt: new Date().toISOString(),
  });
}

export function getTaskPlanFileStatus(taskId: string) {
  const task = findTaskById(taskId);
  if (!task) return null;

  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  const executionRoot = task.worktreePath ?? project.rootPath;

  const canonicalPlanPath = getCanonicalPlanPath({
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
  });

  return {
    exists: existsSync(canonicalPlanPath),
    path: canonicalPlanPath,
  };
}

export function syncTaskPlanFromFile(taskId: string): { synced: boolean } | null {
  const task = findTaskById(taskId);
  if (!task) return null;

  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  const executionRoot = task.worktreePath ?? project.rootPath;

  const canonicalPlanPath = getCanonicalPlanPath({
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
  });
  if (!existsSync(canonicalPlanPath)) {
    return { synced: false };
  }

  const filePlan = readFileSync(canonicalPlanPath, "utf8");
  const normalizedPlan = filePlan.trim().length > 0 ? filePlan : null;

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
    updatedAt: new Date().toISOString(),
  });

  return { synced: true };
}

export {
  toTaskResponse,
  toCommentResponse,
  findTaskById,
  listTaskListItems,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listComments,
  type TaskRow,
  type CommentRow,
};

export function createComment(input: {
  taskId: string;
  participantId?: string | null;
  message: string;
  attachments?: unknown[];
}): CommentRow | undefined {
  return createTaskComment({
    taskId: input.taskId,
    author: "human",
    participantId: input.participantId,
    message: input.message,
    attachments: input.attachments,
  });
}

export function updateComment(
  commentId: string,
  patch: { attachments?: unknown[] },
): CommentRow | undefined {
  return updateTaskComment(commentId, patch);
}
