import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, lte, min, or, sql } from "drizzle-orm";
import {
  AUTO_REVIEW_FINDING_SOURCES,
  AUTO_REVIEW_STRATEGIES,
  appSettings,
  generatePlanPath,
  getProjectConfig,
  logger as createLogger,
  parseAttachments,
  parseTaskTokenUsage,
  persistTaskPlan,
  projects,
  taskComments,
  tasks,
  runtimeProfiles,
  chatSessions,
  chatMessages,
  usageEvents,
  type AppSettings,
  type CreateRuntimeProfileInput,
  type EffectiveRuntimeProfileSelection,
  type RuntimeProfile,
  type UpdateAppSettingsInput,
  type UpdateRuntimeProfileInput,
  type Task,
  type TaskStatus,
  type AutoReviewState,
  type ChatSession,
  type ChatSessionMessage,
  type ChatSessionRow,
  type ChatMessageRow,
  type ChatMessageAttachment,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = createLogger("data");
const AUTO_REVIEW_STRATEGY_SET = new Set<string>(AUTO_REVIEW_STRATEGIES);
const AUTO_REVIEW_FINDING_SOURCE_SET = new Set<string>(AUTO_REVIEW_FINDING_SOURCES);
const APP_SETTINGS_ID = 1;

export type TaskRow = typeof tasks.$inferSelect;
export type CommentRow = typeof taskComments.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type HydratedTaskRow = TaskRow & { autoReviewState?: AutoReviewState | null };

export type CoordinatorStage = "planner" | "plan-checker" | "implementer" | "reviewer";

/** DB-level patch: all mutable task columns with their storage types (attachments/tags as JSON strings). */
export type TaskFieldsPatch = Partial<Omit<TaskRow, "id" | "projectId" | "createdAt">> & {
  autoReviewState?: AutoReviewState | null;
};

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
  manualReviewRequired?: boolean;
  autoReviewState?: AutoReviewState | null;
  paused?: boolean;
  lastHeartbeatAt?: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  position?: number;
  scheduledAt?: string | null;
};


export function toTaskResponse(task: TaskRow): Task {
  const { attachments, tags, runtimeOptionsJson, autoReviewStateJson, ...rest } = task;
  return {
    ...rest,
    attachments: parseAttachments(attachments),
    tags: parseTags(tags),
    autoReviewState: parseAutoReviewState(autoReviewStateJson),
    runtimeOptions: parseRuntimeObject(runtimeOptionsJson),
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

function parseRuntimeObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseAutoReviewState(raw: string | null | undefined): AutoReviewState | null {
  if (!raw) return null;

  const preview = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn({ reason, raw: preview, ...extra }, "Malformed persisted auto-review payload");
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnMalformed("root_not_object");
      return null;
    }

    const candidate = parsed as Record<string, unknown>;

    const strategy =
      typeof candidate.strategy === "string" &&
      AUTO_REVIEW_STRATEGY_SET.has(candidate.strategy)
        ? candidate.strategy
        : null;
    const iteration =
      typeof candidate.iteration === "number" &&
      Number.isFinite(candidate.iteration) &&
      Number.isInteger(candidate.iteration) &&
      candidate.iteration >= 0
        ? candidate.iteration
        : null;
    const findings = Array.isArray(candidate.findings) ? candidate.findings : null;

    if (!strategy || iteration == null || !findings) {
      warnMalformed("missing_required_fields", {
        hasStrategy: Boolean(strategy),
        hasIteration: iteration != null,
        hasFindings: Boolean(findings),
      });
      return null;
    }

    const normalizedFindings: AutoReviewState["findings"] = [];
    for (const item of findings) {
      if (!item || typeof item !== "object") {
        warnMalformed("invalid_finding_shape");
        return null;
      }

      const finding = item as Record<string, unknown>;
      if (
        typeof finding.id !== "string" ||
        typeof finding.text !== "string" ||
        typeof finding.source !== "string" ||
        !AUTO_REVIEW_FINDING_SOURCE_SET.has(finding.source)
      ) {
        warnMalformed("invalid_finding_fields", {
          findingId: finding.id,
          findingSource: finding.source,
        });
        return null;
      }

      normalizedFindings.push({
        id: finding.id,
        text: finding.text,
        source: finding.source as AutoReviewState["findings"][number]["source"],
      });
    }

    if (normalizedFindings.length !== findings.length) {
      warnMalformed("dropped_invalid_findings", {
        expectedCount: findings.length,
        actualCount: normalizedFindings.length,
      });
      return null;
    }

    return {
      strategy: strategy as AutoReviewState["strategy"],
      iteration,
      findings: normalizedFindings,
    };
  } catch (error) {
    warnMalformed("json_parse_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseRuntimeHeaders(raw: string | null | undefined): Record<string, string> {
  const parsed = parseRuntimeObject(raw);
  if (!parsed) return {};

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

function toJsonPayload(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

function toHeadersJsonPayload(value: Record<string, string> | null | undefined): string {
  return JSON.stringify(value ?? {});
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

export function findTaskById(id: string): HydratedTaskRow | undefined {
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) return undefined;
  return {
    ...row,
    autoReviewState: parseAutoReviewState(row.autoReviewStateJson),
  };
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
  | "runtimeProfileId" | "modelOverride"
  | "blockedReason" | "blockedFromStatus" | "retryCount"
  | "reworkRequested" | "reviewIterationCount" | "maxReviewIterations" | "manualReviewRequired"
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
  runtimeProfileId: tasks.runtimeProfileId,
  modelOverride: tasks.modelOverride,
  blockedReason: tasks.blockedReason,
  blockedFromStatus: tasks.blockedFromStatus,
  retryCount: tasks.retryCount,
  reworkRequested: tasks.reworkRequested,
  reviewIterationCount: tasks.reviewIterationCount,
  maxReviewIterations: tasks.maxReviewIterations,
  manualReviewRequired: tasks.manualReviewRequired,
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
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  roadmapAlias?: string;
  tags?: string[];
  scheduledAt?: string | null;
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
      runtimeProfileId: input.runtimeProfileId ?? null,
      modelOverride: input.modelOverride ?? null,
      runtimeOptionsJson:
        input.runtimeOptions === undefined ? null : JSON.stringify(input.runtimeOptions),
      roadmapAlias: input.roadmapAlias ?? null,
      tags: JSON.stringify(input.tags ?? []),
      scheduledAt: input.scheduledAt ?? null,
      reworkRequested: false,
      manualReviewRequired: false,
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
  const { attachments, tags, runtimeOptions, autoReviewState, ...rest } = fields;
  const patch: TaskFieldsPatch = { ...rest, updatedAt: new Date().toISOString() };
  if (attachments !== undefined) {
    patch.attachments = JSON.stringify(attachments);
  }
  if (tags !== undefined) {
    patch.tags = JSON.stringify(tags);
  }
  if (runtimeOptions !== undefined) {
    patch.runtimeOptionsJson = runtimeOptions === null ? null : JSON.stringify(runtimeOptions);
  }
  if (autoReviewState !== undefined) {
    patch.autoReviewStateJson =
      autoReviewState === null ? null : JSON.stringify(autoReviewState);
  }
  if (fields.runtimeProfileId !== undefined || fields.modelOverride !== undefined) {
    log.debug(
      {
        taskId: id,
        runtimeProfileId: fields.runtimeProfileId ?? null,
        modelOverride: fields.modelOverride ?? null,
      },
      "Updated task runtime metadata",
    );
  }
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
  return findTaskById(id);
}

/**
 * Write only the `position` column. Does NOT bump `updatedAt` — manual reorder
 * is metadata, not content, and must not disturb "updated at" sort views.
 */
export function updateTaskPositionOnly(id: string, position: number): void {
  getDb().update(tasks).set({ position }).where(eq(tasks.id, id)).run();
}

export function setTaskFields(id: string, fields: TaskFieldsPatch): void {
  const { autoReviewState, ...rest } = fields;
  const patch: Partial<TaskRow> & { autoReviewStateJson?: string | null } = { ...rest };
  if (autoReviewState !== undefined) {
    patch.autoReviewStateJson =
      autoReviewState === null ? null : JSON.stringify(autoReviewState);
  }
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
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

export function toAppSettingsResponse(row: AppSettingsRow): AppSettings {
  return {
    id: row.id,
    defaultTaskRuntimeProfileId: row.defaultTaskRuntimeProfileId,
    defaultPlanRuntimeProfileId: row.defaultPlanRuntimeProfileId,
    defaultReviewRuntimeProfileId: row.defaultReviewRuntimeProfileId,
    defaultChatRuntimeProfileId: row.defaultChatRuntimeProfileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ensureAppSettingsRow(): AppSettingsRow {
  // Migration 13 seeds row id=1. Keep this fallback for legacy/test databases
  // so read paths stay resilient even when they start from an empty schema.
  const existing = getDb().select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get();
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  log.debug({ appSettingsId: APP_SETTINGS_ID }, "Seeding missing singleton app settings row");
  getDb()
    .insert(appSettings)
    .values({
      id: APP_SETTINGS_ID,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  return getDb().select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get()!;
}

export function getAppSettings(): AppSettingsRow {
  const settings = ensureAppSettingsRow();
  log.debug({ appSettingsId: settings.id }, "Loaded app settings");
  return settings;
}

export function updateAppSettings(input: UpdateAppSettingsInput): AppSettingsRow {
  ensureAppSettingsRow();

  const patch: Partial<AppSettingsRow> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.defaultTaskRuntimeProfileId !== undefined) {
    patch.defaultTaskRuntimeProfileId = input.defaultTaskRuntimeProfileId;
  }
  if (input.defaultPlanRuntimeProfileId !== undefined) {
    patch.defaultPlanRuntimeProfileId = input.defaultPlanRuntimeProfileId;
  }
  if (input.defaultReviewRuntimeProfileId !== undefined) {
    patch.defaultReviewRuntimeProfileId = input.defaultReviewRuntimeProfileId;
  }
  if (input.defaultChatRuntimeProfileId !== undefined) {
    patch.defaultChatRuntimeProfileId = input.defaultChatRuntimeProfileId;
  }

  log.debug(
    {
      appSettingsId: APP_SETTINGS_ID,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
    },
    "Updating app settings runtime defaults",
  );

  getDb()
    .update(appSettings)
    .set(patch)
    .where(eq(appSettings.id, APP_SETTINGS_ID))
    .run();

  return getAppSettings();
}

export function getAppDefaultRuntimeProfileId(
  mode: "task" | "plan" | "review" | "chat",
): string | null {
  const settings = getAppSettings();
  const candidates =
    mode === "chat"
      ? [{ slot: "chat", profileId: settings.defaultChatRuntimeProfileId }]
      : mode === "plan"
        ? [
            { slot: "plan", profileId: settings.defaultPlanRuntimeProfileId },
            { slot: "task", profileId: settings.defaultTaskRuntimeProfileId },
          ]
        : mode === "review"
          ? [
              { slot: "review", profileId: settings.defaultReviewRuntimeProfileId },
              { slot: "task", profileId: settings.defaultTaskRuntimeProfileId },
            ]
          : [{ slot: "task", profileId: settings.defaultTaskRuntimeProfileId }];

  const seenProfileIds = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.profileId || seenProfileIds.has(candidate.profileId)) continue;
    seenProfileIds.add(candidate.profileId);

    const profile = findRuntimeProfileById(candidate.profileId);
    if (!profile) {
      log.warn(
        { mode, appDefaultSlot: candidate.slot, runtimeProfileId: candidate.profileId },
        "App runtime default points to a missing profile",
      );
      continue;
    }
    if (profile.projectId != null) {
      log.warn(
        {
          mode,
          appDefaultSlot: candidate.slot,
          runtimeProfileId: candidate.profileId,
          ownerProjectId: profile.projectId,
        },
        "App runtime default points to a project-scoped profile",
      );
      continue;
    }
    if (!profile.enabled) {
      log.warn(
        { mode, appDefaultSlot: candidate.slot, runtimeProfileId: candidate.profileId },
        "App runtime default points to a disabled profile",
      );
      continue;
    }

    return profile.id;
  }

  return null;
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
  parallelEnabled?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}): ProjectRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug(
    {
      projectId: id,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
    },
    "Creating project runtime defaults",
  );
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
      parallelEnabled: input.parallelEnabled ?? false,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
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
    parallelEnabled?: boolean;
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): ProjectRow | undefined {
  log.debug(
    {
      projectId: id,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
    },
    "Updating project runtime defaults",
  );
  getDb()
    .update(projects)
    .set({
      name: input.name,
      rootPath: input.rootPath,
      plannerMaxBudgetUsd: input.plannerMaxBudgetUsd ?? null,
      planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd ?? null,
      implementerMaxBudgetUsd: input.implementerMaxBudgetUsd ?? null,
      reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd ?? null,
      parallelEnabled: input.parallelEnabled ?? false,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
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
  return findCoordinatorTaskCandidates(stage, 1)[0];
}

export function findCoordinatorTaskCandidates(stage: CoordinatorStage, limit: number): TaskRow[] {
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

  const nowIso = new Date().toISOString();

  return getDb()
    .select()
    .from(tasks)
    .where(and(
      stageFilter,
      eq(tasks.paused, false),
      or(
        sql`${tasks.lockedBy} IS NULL`,
        lte(tasks.lockedUntil, nowIso),
      ),
    ))
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
    .limit(limit)
    .all();
}

/** Atomically claim a task for processing. Returns true if claim succeeded. */
export function claimTask(taskId: string, coordinatorId: string, lockDurationMs: number): boolean {
  const nowIso = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + lockDurationMs).toISOString();

  const result = getDb()
    .update(tasks)
    .set({ lockedBy: coordinatorId, lockedUntil })
    .where(and(
      eq(tasks.id, taskId),
      or(
        sql`${tasks.lockedBy} IS NULL`,
        lte(tasks.lockedUntil, nowIso),
      ),
    ))
    .run();

  return result.changes > 0;
}

/** Check if any task in a project is currently locked (active, non-expired). */
/**
 * Conditional advance from `backlog` to `planning`. Returns `true` only if
 * the row was actually updated — i.e. the task was still in `backlog` and
 * not paused at the moment of the write. This is the CAS that prevents two
 * coordinator passes (auto-queue + scheduler, or two replicas) from racing
 * the same task through the transition twice. Callers that observe `false`
 * must skip the task without further side effects (no broadcast, no log
 * entry).
 *
 * Clears `scheduledAt` in the same write so the scheduler can't re-fire a
 * task that auto-queue already advanced (or vice versa).
 */
export function claimBacklogTaskForAdvance(taskId: string): boolean {
  const nowIso = new Date().toISOString();
  const result = getDb()
    .update(tasks)
    .set({
      status: "planning",
      scheduledAt: null,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: 0,
      reworkRequested: false,
      reviewIterationCount: 0,
      manualReviewRequired: false,
      autoReviewStateJson: null,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "backlog"), eq(tasks.paused, false)))
    .run();
  return result.changes > 0;
}

/**
 * Count tasks the auto-queue must consider "still in flight" before advancing
 * the next backlog item. Includes blocked_external so retry-cycles don't
 * cause the pool to overshoot. Excludes terminal (done/verified) and the
 * source state (backlog).
 */
export function countActivePipelineTasksForProject(projectId: string): number {
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        inArray(tasks.status, ["planning", "plan_ready", "implementing", "review", "blocked_external"]),
      ),
    )
    .get();
  return row?.cnt ?? 0;
}

export function hasActiveLockedTaskForProject(projectId: string): boolean {
  const nowIso = new Date().toISOString();
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      isNotNull(tasks.lockedBy),
      gt(tasks.lockedUntil, nowIso),
    ))
    .get();
  return (row?.cnt ?? 0) > 0;
}

/** Extend lock expiry for a task owned by this coordinator. */
export function renewTaskClaim(taskId: string, coordinatorId: string, lockDurationMs: number): void {
  const lockedUntil = new Date(Date.now() + lockDurationMs).toISOString();
  getDb()
    .update(tasks)
    .set({ lockedUntil })
    .where(and(eq(tasks.id, taskId), eq(tasks.lockedBy, coordinatorId)))
    .run();
}

/** Release a task claim after processing completes. */
export function releaseTaskClaim(taskId: string): void {
  getDb()
    .update(tasks)
    .set({ lockedBy: null, lockedUntil: null })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Release expired or abandoned task claims. Returns count of released claims. */
export function releaseStaleTaskClaims(): number {
  const nowIso = new Date().toISOString();
  // Heartbeat older than 5 minutes means the process is dead
  const heartbeatDeadline = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const result = getDb()
    .update(tasks)
    .set({ lockedBy: null, lockedUntil: null })
    .where(and(
      isNotNull(tasks.lockedBy),
      or(
        // Lock TTL expired
        lte(tasks.lockedUntil, nowIso),
        // Process died: heartbeat stale, task still in-progress, and not freshly claimed
        and(
          inArray(tasks.status, ["planning", "implementing", "review"]),
          // Ensure task was claimed at least 5 min ago (avoid race with fresh claims)
          lte(tasks.updatedAt, heartbeatDeadline),
          or(
            sql`${tasks.lastHeartbeatAt} IS NULL`,
            lte(tasks.lastHeartbeatAt, heartbeatDeadline),
          ),
        ),
      ),
    ))
    .run();
  return result.changes;
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

/** Backlog tasks whose `scheduledAt` is due (<= nowIso). Skips paused tasks. */
export function listDueScheduledTasks(nowIso: string): TaskRow[] {
  log.debug({ nowIso }, "Scanning for due scheduled tasks");
  const rows = getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "backlog"),
        eq(tasks.paused, false),
        isNotNull(tasks.scheduledAt),
        lte(tasks.scheduledAt, nowIso),
      ),
    )
    .all();
  log.debug({ dueCount: rows.length }, "Due scheduled tasks resolved");
  return rows;
}

/** Clear scheduledAt after firing; bumps updatedAt. */
export function clearScheduledAt(taskId: string): void {
  log.debug({ taskId }, "Clearing scheduledAt");
  const nowIso = new Date().toISOString();
  getDb()
    .update(tasks)
    .set({ scheduledAt: null, updatedAt: nowIso })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Set or clear scheduledAt. Caller validates the ISO string upstream. */
export function updateScheduledAt(taskId: string, scheduledAt: string | null): void {
  log.debug({ taskId, scheduledAt }, "Updating scheduledAt");
  const nowIso = new Date().toISOString();
  getDb()
    .update(tasks)
    .set({ scheduledAt, updatedAt: nowIso })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Read the auto-queue flag for a project. Returns false for unknown projects. */
export function getAutoQueueMode(projectId: string): boolean {
  const row = getDb()
    .select({ autoQueueMode: projects.autoQueueMode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return Boolean(row?.autoQueueMode);
}

/** Projects with `autoQueueMode = true`. Used by the coordinator's auto-advance pass. */
export function listAutoQueueProjects(): ProjectRow[] {
  return getDb().select().from(projects).where(eq(projects.autoQueueMode, true)).all();
}

/** Toggle the project-level auto-queue flag. */
export function setAutoQueueMode(projectId: string, enabled: boolean): void {
  log.info({ projectId, enabled }, "Setting auto-queue mode");
  const nowIso = new Date().toISOString();
  getDb()
    .update(projects)
    .set({ autoQueueMode: enabled, updatedAt: nowIso })
    .where(eq(projects.id, projectId))
    .run();
}

/**
 * Next backlog task in a project ordered by `position` ascending.
 * Skips paused tasks and tasks that still have a future `scheduledAt`
 * (those belong to the scheduled-task trigger, not the auto-queue advancer).
 */
export function nextBacklogTaskByPosition(projectId: string): TaskRow | undefined {
  const nowIso = new Date().toISOString();
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, "backlog"),
        eq(tasks.paused, false),
        or(
          isNull(tasks.scheduledAt),
          lte(tasks.scheduledAt, nowIso),
        ),
      ),
    )
    .orderBy(asc(tasks.position))
    .limit(1)
    .get();
}

export function listStaleInProgressTasks(): TaskRow[] {
  const nowIso = new Date().toISOString();
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["planning", "implementing", "review"]),
        eq(tasks.paused, false),
        // Skip tasks with active (non-expired) locks — they're being processed
        or(
          sql`${tasks.lockedBy} IS NULL`,
          lte(tasks.lockedUntil, nowIso),
        ),
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

export function incrementProjectTokenUsage(
  projectId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(projects)
    .set({
      tokenInput: sql<number>`coalesce(${projects.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${projects.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${projects.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${projects.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(projects.id, projectId))
    .run();

  return delta;
}

export function incrementChatSessionTokenUsage(
  chatSessionId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(chatSessions)
    .set({
      tokenInput: sql<number>`coalesce(${chatSessions.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${chatSessions.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${chatSessions.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${chatSessions.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(chatSessions.id, chatSessionId))
    .run();

  return delta;
}

// ---------------------------------------------------------------------------
// Usage event sink — structural type matching `@aif/runtime`'s RuntimeUsageSink
// ---------------------------------------------------------------------------

/**
 * Structural shape of a usage event. Mirrors `RuntimeUsageEvent` from
 * `@aif/runtime/usageSink` without an import so `@aif/data` stays free of
 * a dependency on `@aif/runtime` (runtime → shared → data is the intended
 * direction; data must not know about the runtime layer).
 *
 * The host process (api or agent) passes `createDbUsageSink()` to
 * `createRuntimeRegistry({ usageSink })`, where TypeScript's structural
 * typing verifies that the returned object satisfies `RuntimeUsageSink`.
 */
export interface DbUsageEvent {
  context: {
    source: string;
    projectId?: string | null;
    taskId?: string | null;
    chatSessionId?: string | null;
  };
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  transport?: string;
  workflowKind?: string;
  usageReporting: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
  recordedAt: Date;
}

export interface DbUsageSink {
  record(event: DbUsageEvent): void;
}

/**
 * Insert a `usage_events` row and roll the usage delta into whichever
 * per-entity aggregate counters the event has scope for (task, project,
 * chat-session). Any subset of scopes may be present — a chat turn has
 * project + chat-session but no task; a subagent run has project + task
 * but no chat-session; a commit run has only project.
 *
 * Runs all four writes in a single transaction so the append-only log and
 * the rolled-up counters stay consistent.
 */
export function recordUsageEvent(event: DbUsageEvent): void {
  const { usage, context } = event;
  const db = getDb();

  // Wrap insert + aggregate updates in a single transaction so the
  // append-only log and rolled-up counters stay consistent. If any
  // update fails the entire batch rolls back — no partial divergence.
  db.transaction((tx) => {
    tx.insert(usageEvents)
      .values({
        source: context.source,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        chatSessionId: context.chatSessionId ?? null,
        runtimeId: event.runtimeId,
        providerId: event.providerId,
        profileId: event.profileId ?? null,
        transport: event.transport ?? null,
        workflowKind: event.workflowKind ?? null,
        usageReporting: event.usageReporting,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd ?? null,
      })
      .run();

    // Use usage.totalTokens (the provider's authoritative total) for all
    // aggregates — same source of truth as the usage_events row. Never
    // recalculate as inputTokens + outputTokens: providers may include
    // additional token categories (cache, reasoning, etc.) in their total.
    const totalTokensDelta = usage.totalTokens;
    const costDelta = usage.costUsd ?? 0;

    if (context.taskId) {
      tx.update(tasks)
        .set({
          tokenInput: sql<number>`coalesce(${tasks.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${tasks.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${tasks.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${tasks.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(tasks.id, context.taskId))
        .run();
    }
    if (context.projectId) {
      tx.update(projects)
        .set({
          tokenInput: sql<number>`coalesce(${projects.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${projects.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${projects.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${projects.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(projects.id, context.projectId))
        .run();
    }
    if (context.chatSessionId) {
      tx.update(chatSessions)
        .set({
          tokenInput: sql<number>`coalesce(${chatSessions.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${chatSessions.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${chatSessions.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${chatSessions.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(chatSessions.id, context.chatSessionId))
        .run();
    }
  });
}

/**
 * Build a `DbUsageSink` (structurally compatible with
 * `@aif/runtime.RuntimeUsageSink`) that persists every event via
 * `recordUsageEvent`. Sink methods are non-throwing: any DB error is logged
 * and swallowed so a broken sink never breaks the caller mid-run.
 */
export function createDbUsageSink(): DbUsageSink {
  return {
    record(event) {
      try {
        recordUsageEvent(event);
      } catch (err) {
        log.error(
          {
            err,
            runtimeId: event.runtimeId,
            source: event.context.source,
          },
          "Failed to record usage event — dropping silently",
        );
      }
    },
  };
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

// ── Runtime Profiles ──────────────────────────────────────────

export function toRuntimeProfileResponse(row: RuntimeProfileRow): RuntimeProfile {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    runtimeId: row.runtimeId,
    providerId: row.providerId,
    transport: row.transport,
    baseUrl: row.baseUrl,
    apiKeyEnvVar: row.apiKeyEnvVar,
    defaultModel: row.defaultModel,
    headers: parseRuntimeHeaders(row.headersJson),
    options: parseRuntimeObject(row.optionsJson) ?? {},
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findRuntimeProfileById(id: string): RuntimeProfileRow | undefined {
  return getDb().select().from(runtimeProfiles).where(eq(runtimeProfiles.id, id)).get();
}

export function listRuntimeProfiles(input: {
  projectId?: string;
  includeGlobal?: boolean;
  enabledOnly?: boolean;
} = {}): RuntimeProfileRow[] {
  const conditions = [];
  if (input.projectId) {
    if (input.includeGlobal) {
      conditions.push(or(eq(runtimeProfiles.projectId, input.projectId), isNull(runtimeProfiles.projectId)));
    } else {
      conditions.push(eq(runtimeProfiles.projectId, input.projectId));
    }
  }
  if (input.enabledOnly) {
    conditions.push(eq(runtimeProfiles.enabled, true));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  log.debug(
    {
      projectId: input.projectId ?? null,
      includeGlobal: input.includeGlobal ?? false,
      enabledOnly: input.enabledOnly ?? false,
    },
    "Listing runtime profiles",
  );
  return getDb()
    .select()
    .from(runtimeProfiles)
    .where(where)
    .orderBy(asc(runtimeProfiles.createdAt))
    .all();
}

export function createRuntimeProfile(input: CreateRuntimeProfileInput): RuntimeProfileRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug(
    {
      runtimeProfileId: id,
      projectId: input.projectId ?? null,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      enabled: input.enabled ?? true,
    },
    "Creating runtime profile",
  );
  getDb()
    .insert(runtimeProfiles)
    .values({
      id,
      projectId: input.projectId ?? null,
      name: input.name,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      transport: input.transport ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKeyEnvVar: input.apiKeyEnvVar ?? null,
      defaultModel: input.defaultModel ?? null,
      headersJson: toHeadersJsonPayload(input.headers),
      optionsJson: toJsonPayload(input.options),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findRuntimeProfileById(id);
}

export function updateRuntimeProfile(
  id: string,
  input: UpdateRuntimeProfileInput,
): RuntimeProfileRow | undefined {
  const patch: Partial<RuntimeProfileRow> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.name !== undefined) patch.name = input.name;
  if (input.runtimeId !== undefined) patch.runtimeId = input.runtimeId;
  if (input.providerId !== undefined) patch.providerId = input.providerId;
  if (input.transport !== undefined) patch.transport = input.transport;
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
  if (input.apiKeyEnvVar !== undefined) patch.apiKeyEnvVar = input.apiKeyEnvVar;
  if (input.defaultModel !== undefined) patch.defaultModel = input.defaultModel;
  if (input.headers !== undefined) patch.headersJson = toHeadersJsonPayload(input.headers);
  if (input.options !== undefined) patch.optionsJson = toJsonPayload(input.options);
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  log.debug(
    {
      runtimeProfileId: id,
      runtimeId: input.runtimeId ?? null,
      providerId: input.providerId ?? null,
      enabled: input.enabled ?? null,
    },
    "Updating runtime profile",
  );
  getDb().update(runtimeProfiles).set(patch).where(eq(runtimeProfiles.id, id)).run();
  return findRuntimeProfileById(id);
}

export function deleteRuntimeProfile(id: string): void {
  log.debug({ runtimeProfileId: id }, "Deleting runtime profile");
  getDb().delete(runtimeProfiles).where(eq(runtimeProfiles.id, id)).run();
}

export function isRuntimeProfileVisibleToProject(input: {
  projectId: string;
  runtimeProfileId: string | null;
}): boolean {
  if (input.runtimeProfileId == null) {
    log.debug({ projectId: input.projectId, runtimeProfileId: null }, "Null runtime profile is visible");
    return true;
  }

  const profile = findRuntimeProfileById(input.runtimeProfileId);
  const isVisible =
    profile != null && (profile.projectId == null || profile.projectId === input.projectId);

  log.debug(
    {
      projectId: input.projectId,
      runtimeProfileId: input.runtimeProfileId,
      ownerProjectId: profile?.projectId ?? null,
      isVisible,
    },
    "Checked runtime profile visibility for project",
  );

  return isVisible;
}

export function isRuntimeProfileEligibleForAppDefaults(runtimeProfileId: string | null): boolean {
  if (runtimeProfileId == null) {
    log.debug({ runtimeProfileId: null }, "Null runtime profile is eligible for app defaults");
    return true;
  }

  const profile = findRuntimeProfileById(runtimeProfileId);
  const isEligible = profile != null && profile.projectId == null && profile.enabled;

  log.debug(
    {
      runtimeProfileId,
      ownerProjectId: profile?.projectId ?? null,
      enabled: profile?.enabled ?? null,
      isEligible,
    },
    "Checked runtime profile eligibility for app defaults",
  );

  return isEligible;
}

export function updateProjectRuntimeDefaults(
  projectId: string,
  input: {
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): ProjectRow | undefined {
  log.debug({ projectId, ...input }, "Updating project runtime default profiles");
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.defaultTaskRuntimeProfileId !== undefined) patch.defaultTaskRuntimeProfileId = input.defaultTaskRuntimeProfileId;
  if (input.defaultPlanRuntimeProfileId !== undefined) patch.defaultPlanRuntimeProfileId = input.defaultPlanRuntimeProfileId;
  if (input.defaultReviewRuntimeProfileId !== undefined) patch.defaultReviewRuntimeProfileId = input.defaultReviewRuntimeProfileId;
  if (input.defaultChatRuntimeProfileId !== undefined) patch.defaultChatRuntimeProfileId = input.defaultChatRuntimeProfileId;
  getDb().update(projects).set(patch).where(eq(projects.id, projectId)).run();
  return findProjectById(projectId);
}

export function updateTaskRuntimeOverride(
  taskId: string,
  input: {
    runtimeProfileId?: string | null;
    modelOverride?: string | null;
    runtimeOptions?: Record<string, unknown> | null;
  },
): TaskRow | undefined {
  const patch: Partial<TaskRow> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.runtimeProfileId !== undefined) patch.runtimeProfileId = input.runtimeProfileId;
  if (input.modelOverride !== undefined) patch.modelOverride = input.modelOverride;
  if (input.runtimeOptions !== undefined) {
    patch.runtimeOptionsJson =
      input.runtimeOptions === null ? null : JSON.stringify(input.runtimeOptions);
  }

  log.debug(
    {
      taskId,
      runtimeProfileId: input.runtimeProfileId ?? null,
      modelOverride: input.modelOverride ?? null,
      hasRuntimeOptions: input.runtimeOptions !== undefined,
    },
    "Updating task runtime override",
  );
  getDb().update(tasks).set(patch).where(eq(tasks.id, taskId)).run();
  return findTaskById(taskId);
}

export function updateChatSessionRuntime(
  sessionId: string,
  input: {
    runtimeProfileId?: string | null;
    runtimeSessionId?: string | null;
  },
): ChatSessionRow | undefined {
  log.debug(
    {
      sessionId,
      runtimeProfileId: input.runtimeProfileId ?? null,
      hasRuntimeSessionId: input.runtimeSessionId !== undefined,
    },
    "Updating chat session runtime metadata",
  );
  getDb()
    .update(chatSessions)
    .set({
      ...(input.runtimeProfileId !== undefined ? { runtimeProfileId: input.runtimeProfileId } : {}),
      ...(input.runtimeSessionId !== undefined ? { runtimeSessionId: input.runtimeSessionId } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(chatSessions.id, sessionId))
    .run();
  return findChatSessionById(sessionId);
}

export function resolveEffectiveRuntimeProfile(input: {
  taskId?: string;
  projectId?: string;
  mode?: "task" | "plan" | "review" | "chat";
  systemDefaultRuntimeProfileId?: string | null;
}): EffectiveRuntimeProfileSelection {
  const mode = input.mode ?? "task";
  const task = input.taskId ? findTaskById(input.taskId) : undefined;
  const projectId = input.projectId ?? task?.projectId;
  const project = projectId ? findProjectById(projectId) : undefined;

  // Task-level override applies to all stages: if set, the entire task
  // pipeline (plan, implement, review, chat) runs on the specified runtime.
  const taskRuntimeProfileId = task?.runtimeProfileId ?? null;

  let projectRuntimeProfileId: string | null = null;
  if (mode === "chat") {
    projectRuntimeProfileId = project?.defaultChatRuntimeProfileId ?? null;
  } else if (mode === "plan") {
    projectRuntimeProfileId = project?.defaultPlanRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  } else if (mode === "review") {
    projectRuntimeProfileId = project?.defaultReviewRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  } else {
    projectRuntimeProfileId = project?.defaultTaskRuntimeProfileId ?? null;
  }
  const systemRuntimeProfileId = input.systemDefaultRuntimeProfileId ?? null;

  const candidates: Array<{
    source: EffectiveRuntimeProfileSelection["source"];
    profileId: string | null;
  }> = [
    { source: "task_override", profileId: taskRuntimeProfileId },
    { source: "project_default", profileId: projectRuntimeProfileId },
    { source: "system_default", profileId: systemRuntimeProfileId },
  ];

  const unavailableIds: string[] = [];

  for (const candidate of candidates) {
    if (!candidate.profileId) continue;
    const profile = findRuntimeProfileById(candidate.profileId);
    if (!profile || !profile.enabled) {
      unavailableIds.push(candidate.profileId);
      continue;
    }

    if (candidate.source !== "task_override") {
      log.info(
        {
          source: candidate.source,
          taskRuntimeProfileId,
          projectRuntimeProfileId,
          systemRuntimeProfileId,
          unavailableCount: unavailableIds.length,
        },
        "Effective runtime profile fell back from higher-priority source",
      );
    }

    return {
      source: candidate.source,
      profile: toRuntimeProfileResponse(profile),
      taskRuntimeProfileId,
      projectRuntimeProfileId,
      systemRuntimeProfileId,
    };
  }

  return {
    source: "none",
    profile: null,
    taskRuntimeProfileId,
    projectRuntimeProfileId,
    systemRuntimeProfileId,
  };
}

// ── Chat Sessions ──────────────────────────────────────────────

export function toChatSessionResponse(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    agentSessionId: row.agentSessionId,
    runtimeProfileId: row.runtimeProfileId,
    runtimeSessionId: row.runtimeSessionId ?? row.agentSessionId,
    source: "web",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toChatMessageResponse(row: ChatMessageRow): ChatSessionMessage {
  let attachments: ChatMessageAttachment[] | undefined;
  if (row.attachments) {
    try {
      attachments = JSON.parse(row.attachments) as ChatMessageAttachment[];
    } catch {
      // ignore malformed JSON
    }
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    ...(attachments?.length ? { attachments } : {}),
    createdAt: row.createdAt,
  };
}

export function createChatSession(input: {
  projectId: string;
  title?: string;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
}): ChatSessionRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug(
    {
      projectId: input.projectId,
      runtimeProfileId: input.runtimeProfileId ?? null,
    },
    "Creating chat session",
  );
  getDb()
    .insert(chatSessions)
    .values({
      id,
      projectId: input.projectId,
      title: input.title ?? "New Chat",
      runtimeProfileId: input.runtimeProfileId ?? null,
      runtimeSessionId: input.runtimeSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findChatSessionById(id);
}

export function findChatSessionById(id: string): ChatSessionRow | undefined {
  return getDb().select().from(chatSessions).where(eq(chatSessions.id, id)).get();
}

export function listChatSessions(projectId: string, limit = 20): ChatSessionRow[] {
  log.debug("listChatSessions projectId=%s limit=%d", projectId, limit);
  return getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.projectId, projectId))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(limit)
    .all();
}

export function updateChatSession(
  id: string,
  fields: {
    title?: string;
    agentSessionId?: string | null;
    runtimeProfileId?: string | null;
    runtimeSessionId?: string | null;
  },
): ChatSessionRow | undefined {
  log.debug(
    {
      sessionId: id,
      runtimeProfileId: fields.runtimeProfileId ?? null,
      hasRuntimeSessionId: fields.runtimeSessionId !== undefined,
    },
    "Updating chat session runtime metadata",
  );
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.agentSessionId !== undefined) patch.agentSessionId = fields.agentSessionId;
  if (fields.runtimeProfileId !== undefined) patch.runtimeProfileId = fields.runtimeProfileId;
  if (fields.runtimeSessionId !== undefined) patch.runtimeSessionId = fields.runtimeSessionId;
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
  attachments?: ChatMessageAttachment[];
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
      attachments: input.attachments?.length ? JSON.stringify(input.attachments) : null,
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
