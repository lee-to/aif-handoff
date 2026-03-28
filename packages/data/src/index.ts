import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  parseAttachments,
  parseTaskTokenUsage,
  persistTaskPlan,
  projects,
  taskComments,
  tasks,
  type Task,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

export type TaskRow = typeof tasks.$inferSelect;
export type CommentRow = typeof taskComments.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

export type CoordinatorStage = "planner" | "plan-checker" | "implementer" | "reviewer";

/** DB-level patch: all mutable task columns with their storage types (attachments/tags as JSON strings). */
export type TaskFieldsPatch = Partial<Omit<TaskRow, "id" | "projectId" | "createdAt">>;

/** API-level update: domain types (attachments as array, tags as string[]). Serialization handled by data layer. */
export type TaskFieldsUpdate = {
  title?: string;
  description?: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  isFix?: boolean;
  implementationLog?: string | null;
  reviewComments?: string | null;
  agentActivityLog?: string | null;
  blockedReason?: string | null;
  blockedFromStatus?: TaskStatus | null;
  retryAfter?: string | null;
  retryCount?: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias?: string | null;
  tags?: string[];
  reworkRequested?: boolean;
  lastHeartbeatAt?: string | null;
  position?: number;
};


export function toTaskResponse(task: TaskRow): Task {
  const { attachments, tags, ...rest } = task;
  return {
    ...rest,
    attachments: parseAttachments(attachments),
    tags: parseTags(tags),
  };
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function toCommentResponse(comment: CommentRow) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: comment.author,
    message: comment.message,
    attachments: parseAttachments(comment.attachments),
    createdAt: comment.createdAt,
  };
}

export function findTaskById(id: string): TaskRow | undefined {
  return getDb().select().from(tasks).where(eq(tasks.id, id)).get();
}

export function listTasks(projectId?: string): TaskRow[] {
  const db = getDb();
  if (projectId) {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.status), asc(tasks.position))
      .all();
  }
  return db.select().from(tasks).orderBy(asc(tasks.status), asc(tasks.position)).all();
}

export function createTask(input: {
  projectId: string;
  title: string;
  description: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  isFix?: boolean;
  roadmapAlias?: string;
  tags?: string[];
}): TaskRow | undefined {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(tasks)
    .values({
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      attachments: JSON.stringify(input.attachments ?? []),
      priority: input.priority,
      autoMode: input.autoMode,
      isFix: input.isFix,
      roadmapAlias: input.roadmapAlias ?? null,
      tags: JSON.stringify(input.tags ?? []),
      reworkRequested: false,
      status: "backlog",
      position: 1000.0,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return findTaskById(id);
}

export function updateTask(id: string, fields: TaskFieldsUpdate): TaskRow | undefined {
  const { attachments, tags, ...rest } = fields;
  const patch: TaskFieldsPatch = { ...rest, updatedAt: new Date().toISOString() };
  if (attachments !== undefined) {
    patch.attachments = JSON.stringify(attachments);
  }
  if (tags !== undefined) {
    patch.tags = JSON.stringify(tags);
  }
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
  return findTaskById(id);
}

export function setTaskFields(id: string, fields: TaskFieldsPatch): void {
  getDb().update(tasks).set(fields).where(eq(tasks.id, id)).run();
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.delete(tasks).where(eq(tasks.id, id)).run();
  db.delete(taskComments).where(eq(taskComments.taskId, id)).run();
}

export function listTaskComments(taskId: string): CommentRow[] {
  return getDb()
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
    .all();
}

export function createTaskComment(input: {
  taskId: string;
  author: "human" | "agent";
  message: string;
  attachments?: unknown[];
  createdAt?: string;
}): CommentRow | undefined {
  const id = crypto.randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  getDb()
    .insert(taskComments)
    .values({
      id,
      taskId: input.taskId,
      author: input.author,
      message: input.message,
      attachments: JSON.stringify(input.attachments ?? []),
      createdAt,
    })
    .run();
  return getDb().select().from(taskComments).where(eq(taskComments.id, id)).get();
}

export function getLatestHumanComment(taskId: string): CommentRow | undefined {
  return listTaskComments(taskId).filter((comment) => comment.author === "human").at(-1);
}

export function listProjects(): ProjectRow[] {
  return getDb().select().from(projects).all();
}

export function findProjectById(id: string): ProjectRow | undefined {
  return getDb().select().from(projects).where(eq(projects.id, id)).get();
}

export function createProject(input: {
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd?: number | null;
  planCheckerMaxBudgetUsd?: number | null;
  implementerMaxBudgetUsd?: number | null;
  reviewSidecarMaxBudgetUsd?: number | null;
}): ProjectRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .insert(projects)
    .values({
      id,
      name: input.name,
      rootPath: input.rootPath,
      plannerMaxBudgetUsd: input.plannerMaxBudgetUsd ?? null,
      planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd ?? null,
      implementerMaxBudgetUsd: input.implementerMaxBudgetUsd ?? null,
      reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findProjectById(id);
}

export function updateProject(
  id: string,
  input: {
    name: string;
    rootPath: string;
    plannerMaxBudgetUsd?: number | null;
    planCheckerMaxBudgetUsd?: number | null;
    implementerMaxBudgetUsd?: number | null;
    reviewSidecarMaxBudgetUsd?: number | null;
  },
): ProjectRow | undefined {
  getDb()
    .update(projects)
    .set({
      name: input.name,
      rootPath: input.rootPath,
      plannerMaxBudgetUsd: input.plannerMaxBudgetUsd ?? null,
      planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd ?? null,
      implementerMaxBudgetUsd: input.implementerMaxBudgetUsd ?? null,
      reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id))
    .run();
  return findProjectById(id);
}

export function deleteProject(id: string): void {
  getDb().delete(projects).where(eq(projects.id, id)).run();
}

export function findProjectByTaskId(taskId: string): ProjectRow | undefined {
  const task = findTaskById(taskId);
  if (!task) return undefined;
  return findProjectById(task.projectId);
}

export function persistTaskPlanForTask(input: {
  taskId: string;
  planText: string | null;
  updatedAt?: string;
  projectRoot?: string;
  isFix?: boolean;
}): { updatedAt: string } {
  return persistTaskPlan({
    db: getDb(),
    taskId: input.taskId,
    planText: input.planText,
    updatedAt: input.updatedAt,
    projectRoot: input.projectRoot,
    isFix: input.isFix,
  });
}

export function findCoordinatorTaskCandidate(stage: CoordinatorStage): TaskRow | undefined {
  const stageFilter =
    stage === "implementer"
      ? or(
          eq(tasks.status, "implementing"),
          and(eq(tasks.status, "plan_ready"), eq(tasks.autoMode, true)),
        )
      : stage === "plan-checker"
        ? and(eq(tasks.status, "plan_ready"), eq(tasks.autoMode, true))
        : stage === "planner"
          ? inArray(tasks.status, ["planning"])
          : inArray(tasks.status, ["review"]);

  return getDb()
    .select()
    .from(tasks)
    .where(stageFilter)
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
    .limit(1)
    .get();
}

export function listDueBlockedExternalTasks(nowIso: string): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "blocked_external"),
        isNotNull(tasks.retryAfter),
        lte(tasks.retryAfter, nowIso),
        isNotNull(tasks.blockedFromStatus),
      ),
    )
    .all();
}

export function listStaleInProgressTasks(): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["planning", "implementing", "review"]))
    .all();
}

export function appendTaskActivityLog(taskId: string, newLines: string): void {
  const task = findTaskById(taskId);
  const currentLog = task?.agentActivityLog ?? "";
  const updatedLog = currentLog ? `${currentLog}\n${newLines}` : newLines;
  const nowIso = new Date().toISOString();

  setTaskFields(taskId, {
    agentActivityLog: updatedLog,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
  });
}

export function updateTaskHeartbeat(taskId: string): void {
  const nowIso = new Date().toISOString();
  setTaskFields(taskId, { lastHeartbeatAt: nowIso, updatedAt: nowIso });
}

export function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: Omit<TaskFieldsPatch, "status" | "lastHeartbeatAt" | "updatedAt"> = {},
): void {
  const nowIso = new Date().toISOString();
  setTaskFields(taskId, {
    status,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
    ...extra,
  });
}

export function incrementTaskTokenUsage(
  taskId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(tasks)
    .set({
      tokenInput: sql<number>`coalesce(${tasks.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${tasks.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${tasks.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${tasks.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return delta;
}

/**
 * Find existing tasks that match the given project + roadmap alias combination.
 * Used for deduplication during roadmap import.
 */
export function findTasksByRoadmapAlias(projectId: string, alias: string): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.roadmapAlias, alias)))
    .all();
}
