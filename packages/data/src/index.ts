import { and, asc, count, desc, eq, inArray, isNotNull, like, lte, min, or, sql } from "drizzle-orm";
import {
  generatePlanPath,
  getProjectConfig,
  logger as createLogger,
  parseAttachments,
  parseTaskTokenUsage,
  persistTaskPlan,
  projects,
  taskComments,
  tasks,
  chatSessions,
  chatMessages,
  type Task,
  type TaskStatus,
  type ChatSession,
  type ChatSessionMessage,
  type ChatSessionRow,
  type ChatMessageRow,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = createLogger("data");

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
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
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
  reviewIterationCount?: number;
  maxReviewIterations?: number;
  paused?: boolean;
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

/** Summary projection — excludes heavy text fields for list/search responses. */
export type TaskSummaryRow = Pick<TaskRow,
  | "id" | "projectId" | "title" | "status" | "priority" | "position"
  | "autoMode" | "isFix" | "paused" | "roadmapAlias" | "tags"
  | "blockedReason" | "blockedFromStatus" | "retryCount"
  | "reworkRequested" | "reviewIterationCount" | "maxReviewIterations"
  | "tokenTotal" | "costUsd" | "lastSyncedAt" | "createdAt" | "updatedAt"
>;

const SUMMARY_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  status: tasks.status,
  priority: tasks.priority,
  position: tasks.position,
  autoMode: tasks.autoMode,
  isFix: tasks.isFix,
  paused: tasks.paused,
  roadmapAlias: tasks.roadmapAlias,
  tags: tasks.tags,
  blockedReason: tasks.blockedReason,
  blockedFromStatus: tasks.blockedFromStatus,
  retryCount: tasks.retryCount,
  reworkRequested: tasks.reworkRequested,
  reviewIterationCount: tasks.reviewIterationCount,
  maxReviewIterations: tasks.maxReviewIterations,
  tokenTotal: tasks.tokenTotal,
  costUsd: tasks.costUsd,
  lastSyncedAt: tasks.lastSyncedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
} as const;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * List tasks with pagination and optional filters.
 * Returns summary rows (no plan, description, logs) to keep payloads small.
 */
export function listTasksPaginated(options: {
  projectId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): PaginatedResult<TaskSummaryRow> {
  const db = getDb();
  const lim = Math.min(options.limit ?? 20, 100);
  const off = options.offset ?? 0;

  const conditions = [];
  if (options.projectId) conditions.push(eq(tasks.projectId, options.projectId));
  if (options.status) conditions.push(eq(tasks.status, options.status as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db
    .select({ count: count() })
    .from(tasks)
    .where(where)
    .get()?.count ?? 0;

  const items = db
    .select(SUMMARY_COLUMNS)
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.status), asc(tasks.position))
    .limit(lim)
    .offset(off)
    .all();

  return { items, total, limit: lim, offset: off };
}

/**
 * Search tasks with pagination. Returns summary rows.
 */
export function searchTasksPaginated(options: {
  query: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}): PaginatedResult<TaskSummaryRow> {
  const db = getDb();
  const lim = Math.min(options.limit ?? 20, 50);
  const off = options.offset ?? 0;
  const pattern = `%${options.query}%`;

  const conditions = [
    or(like(tasks.title, pattern), like(tasks.description, pattern)),
  ];
  if (options.projectId) conditions.push(eq(tasks.projectId, options.projectId));

  const where = and(...conditions);

  const total = db
    .select({ count: count() })
    .from(tasks)
    .where(where)
    .get()?.count ?? 0;

  const items = db
    .select(SUMMARY_COLUMNS)
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.updatedAt))
    .limit(lim)
    .offset(off)
    .all();

  return { items, total, limit: lim, offset: off };
}

/** Convert a TaskSummaryRow to a JSON-safe object (parse tags). */
export function toTaskSummary(row: TaskSummaryRow) {
  const { tags, ...rest } = row;
  return {
    ...rest,
    tags: parseTags(tags),
  };
}

export function createTask(input: {
  projectId: string;
  title: string;
  description: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  maxReviewIterations?: number;
  paused?: boolean;
  roadmapAlias?: string;
  tags?: string[];
}): TaskRow | undefined {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Auto-compute planPath for full mode when no explicit path is provided
  let resolvedPlanPath = input.planPath;
  if (input.plannerMode === "full") {
    const project = findProjectById(input.projectId);
    const projectRoot = project?.rootPath ?? process.cwd();
    const cfg = getProjectConfig(projectRoot);
    const defaultPlanPath = cfg.paths.plan;

    if (resolvedPlanPath === undefined || resolvedPlanPath === defaultPlanPath) {
      resolvedPlanPath = generatePlanPath(input.title, "full", {
        plansDir: cfg.paths.plans,
        defaultPlanPath,
      });
      log.debug("Auto-generated plan path for full mode: %s", resolvedPlanPath);
    }
  }

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
      plannerMode: input.plannerMode,
      planPath: resolvedPlanPath,
      planDocs: input.planDocs,
      planTests: input.planTests,
      skipReview: input.skipReview,
      useSubagents: input.useSubagents,
      maxReviewIterations: input.maxReviewIterations,
      paused: input.paused,
      roadmapAlias: input.roadmapAlias ?? null,
      tags: JSON.stringify(input.tags ?? []),
      reworkRequested: false,
      status: "backlog",
      position: (() => {
        const row = db
          .select({ minPos: min(tasks.position) })
          .from(tasks)
          .where(eq(tasks.status, "backlog"))
          .get();
        return (row?.minPos != null ? Number(row.minPos) : 1000) - 100;
      })(),
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

export function updateTaskComment(
  commentId: string,
  patch: { attachments?: unknown[] },
): CommentRow | undefined {
  const sets: Record<string, unknown> = {};
  if (patch.attachments !== undefined) {
    sets.attachments = JSON.stringify(patch.attachments);
  }
  if (Object.keys(sets).length === 0) return getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).get();
  getDb()
    .update(taskComments)
    .set(sets)
    .where(eq(taskComments.id, commentId))
    .run();
  return getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).get();
}

export function getLatestHumanComment(taskId: string): CommentRow | undefined {
  return listTaskComments(taskId).filter((comment) => comment.author === "human").at(-1);
}

export function getLatestReworkComment(taskId: string): CommentRow | undefined {
  return listTaskComments(taskId).at(-1);
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
  planPath?: string;
}): { updatedAt: string } {
  return persistTaskPlan({
    db: getDb(),
    taskId: input.taskId,
    planText: input.planText,
    updatedAt: input.updatedAt,
    projectRoot: input.projectRoot,
    isFix: input.isFix,
    planPath: input.planPath,
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
    .where(and(stageFilter, eq(tasks.paused, false)))
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
        eq(tasks.paused, false),
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
    .where(
      and(
        inArray(tasks.status, ["planning", "implementing", "review"]),
        eq(tasks.paused, false),
      ),
    )
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
    sessionId: null,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
    ...extra,
  });
}

export function saveTaskSessionId(taskId: string, sessionId: string): void {
  setTaskFields(taskId, { sessionId });
}

export function getTaskSessionId(taskId: string): string | null {
  const task = findTaskById(taskId);
  return task?.sessionId ?? null;
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
/**
 * Full-text search across task title and description.
 * Case-insensitive SQL LIKE-based search. Returns matching tasks ordered by updatedAt desc.
 * Limited to 50 results.
 */
export function searchTasks(query: string, projectId?: string): TaskRow[] {
  const db = getDb();
  const pattern = `%${query}%`;
  const conditions = [
    or(
      like(tasks.title, pattern),
      like(tasks.description, pattern),
    ),
  ];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.updatedAt))
    .limit(50)
    .all();
}

/**
 * Update the lastSyncedAt timestamp for a task (called by MCP sync operations).
 */
export function touchLastSyncedAt(taskId: string): void {
  const nowIso = new Date().toISOString();
  setTaskFields(taskId, { lastSyncedAt: nowIso });
}

export function findTasksByRoadmapAlias(projectId: string, alias: string): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.roadmapAlias, alias)))
    .all();
}

// ── Chat Sessions ──────────────────────────────────────────────

export function toChatSessionResponse(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    agentSessionId: row.agentSessionId,
    source: "web",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toChatMessageResponse(row: ChatMessageRow): ChatSessionMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
}

export function createChatSession(input: {
  projectId: string;
  title?: string;
}): ChatSessionRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug("createChatSession projectId=%s title=%s", input.projectId, input.title ?? "New Chat");
  getDb()
    .insert(chatSessions)
    .values({
      id,
      projectId: input.projectId,
      title: input.title ?? "New Chat",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findChatSessionById(id);
}

export function findChatSessionById(id: string): ChatSessionRow | undefined {
  return getDb().select().from(chatSessions).where(eq(chatSessions.id, id)).get();
}

export function listChatSessions(projectId: string): ChatSessionRow[] {
  log.debug("listChatSessions projectId=%s", projectId);
  return getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.projectId, projectId))
    .orderBy(desc(chatSessions.updatedAt))
    .all();
}

export function updateChatSession(
  id: string,
  fields: { title?: string; agentSessionId?: string | null },
): ChatSessionRow | undefined {
  log.debug("updateChatSession id=%s fields=%o", id, fields);
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.agentSessionId !== undefined) patch.agentSessionId = fields.agentSessionId;
  getDb().update(chatSessions).set(patch).where(eq(chatSessions.id, id)).run();
  return findChatSessionById(id);
}

export function deleteChatSession(id: string): void {
  log.debug("deleteChatSession id=%s", id);
  const db = getDb();
  db.delete(chatMessages).where(eq(chatMessages.sessionId, id)).run();
  db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
}

export function createChatMessage(input: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
}): ChatMessageRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug("createChatMessage sessionId=%s role=%s", input.sessionId, input.role);
  getDb()
    .insert(chatMessages)
    .values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: now,
    })
    .run();
  return getDb().select().from(chatMessages).where(eq(chatMessages.id, id)).get();
}

export function listChatMessages(sessionId: string): ChatMessageRow[] {
  log.debug("listChatMessages sessionId=%s", sessionId);
  return getDb()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt))
    .all();
}

export function updateChatSessionTimestamp(id: string): void {
  log.debug("updateChatSessionTimestamp id=%s", id);
  getDb()
    .update(chatSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(chatSessions.id, id))
    .run();
}
