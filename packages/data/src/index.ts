import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";
import {
  AUTO_REVIEW_FINDING_SOURCES,
  AUTO_REVIEW_STRATEGIES,
  buildRuntimeLimitSignature,
  appSettings,
  generatePlanPath,
  getProjectConfig,
  logger as createLogger,
  normalizeRuntimeLimitSnapshot,
  redactProviderText,
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
  codexSessions,
  codexSessionFiles,
  codexLimitHeads,
  codexLimitHistory,
  codexIndexCursors,
  type AppSettings,
  type CreateRuntimeProfileInput,
  type EffectiveRuntimeProfileSelection,
  type RuntimeProfile,
  type RuntimeProfileUsage,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
  type RuntimeLimitFutureHint,
  type UpdateAppSettingsInput,
  type UpdateRuntimeProfileInput,
  type Task,
  type TaskStatus,
  resolveRuntimeLimitFutureHint,
  sanitizeRuntimeLimitSnapshotForExposure,
  selectViolatedWindowForExactThreshold,
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
export type CodexSessionIndexRow = typeof codexSessions.$inferSelect;
export type CodexSessionFileIndexRow = typeof codexSessionFiles.$inferSelect;
export type CodexLimitHeadIndexRow = typeof codexLimitHeads.$inferSelect;
export type CodexLimitHistoryIndexRow = typeof codexLimitHistory.$inferSelect;
export type CodexIndexCursorRow = typeof codexIndexCursors.$inferSelect;
export type HydratedTaskRow = TaskRow & {
  autoReviewState?: AutoReviewState | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
};

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

function redactTaskTextForExternalUse(text: string | null | undefined): string | null {
  if (typeof text !== "string") {
    return text ?? null;
  }
  return text
    .split(/\r?\n/)
    .map((line) => redactProviderText(line))
    .join("\n");
}

function parseTaskRuntimeLimitSnapshot(
  raw: string | null | undefined,
  taskId: string,
): RuntimeLimitSnapshot | null {
  const snapshot = parseRuntimeLimitSnapshot(raw, "task", taskId);
  return snapshot ? sanitizeRuntimeLimitSnapshotForExposure(snapshot, "task") : null;
}

export function toTaskResponse(task: TaskRow): Task {
  const {
    attachments,
    tags,
    runtimeOptionsJson,
    autoReviewStateJson,
    runtimeLimitSnapshotJson,
    ...rest
  } = task;
  return {
    ...rest,
    attachments: parseAttachments(attachments),
    tags: parseTags(tags),
    autoReviewState: parseAutoReviewState(autoReviewStateJson),
    runtimeOptions: parseRuntimeObject(runtimeOptionsJson),
    agentActivityLog: redactTaskTextForExternalUse(task.agentActivityLog),
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(runtimeLimitSnapshotJson, task.id),
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

interface RuntimeProfileUsageState {
  lastUsage: RuntimeProfileUsage;
  lastUsageAt: string;
}

function toRuntimeProfileUsage(row: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
}): RuntimeProfileUsage {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readStoredOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!hasOwnProperty(record, key)) return undefined;
  const value = record[key];
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStoredOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasOwnProperty(record, key)) return undefined;
  const value = record[key];
  if (value == null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseRuntimeLimitWindow(
  value: unknown,
  entity: "task" | "runtime_profile" | "codex_limit_head" | "codex_limit_history",
  entityId: string,
  index: number,
  rawLength: number,
): RuntimeLimitWindow | null {
  if (!isObjectRecord(value) || typeof value.scope !== "string") {
    log.warn(
      { entity, entityId, index, rawLength },
      "Malformed persisted runtime-limit window",
    );
    return null;
  }

  const name = readStoredOptionalString(value, "name");
  const unit = readStoredOptionalString(value, "unit");
  const limit = readStoredOptionalFiniteNumber(value, "limit");
  const remaining = readStoredOptionalFiniteNumber(value, "remaining");
  const used = readStoredOptionalFiniteNumber(value, "used");
  const percentUsed = readStoredOptionalFiniteNumber(value, "percentUsed");
  const percentRemaining = readStoredOptionalFiniteNumber(value, "percentRemaining");
  const resetAt = readStoredOptionalString(value, "resetAt");
  const retryAfterSeconds = readStoredOptionalFiniteNumber(value, "retryAfterSeconds");
  const warningThreshold = readStoredOptionalFiniteNumber(value, "warningThreshold");

  return {
    scope: value.scope as RuntimeLimitWindow["scope"],
    ...(name !== undefined ? { name } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(percentUsed !== undefined ? { percentUsed } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(warningThreshold !== undefined ? { warningThreshold } : {}),
  };
}

function parseRuntimeLimitSnapshot(
  raw: string | null | undefined,
  entity: "task" | "runtime_profile" | "codex_limit_head" | "codex_limit_history",
  entityId: string,
): RuntimeLimitSnapshot | null {
  if (!raw) return null;

  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn(
      { entity, entityId, reason, rawLength: raw.length, ...extra },
      "Malformed persisted runtime-limit snapshot",
    );
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      warnMalformed("root_not_object");
      return null;
    }

    if (
      typeof parsed.source !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.precision !== "string" ||
      typeof parsed.checkedAt !== "string" ||
      typeof parsed.providerId !== "string" ||
      !Array.isArray(parsed.windows)
    ) {
      warnMalformed("missing_required_fields", {
        hasSource: typeof parsed.source === "string",
        hasStatus: typeof parsed.status === "string",
        hasPrecision: typeof parsed.precision === "string",
        hasCheckedAt: typeof parsed.checkedAt === "string",
        hasProviderId: typeof parsed.providerId === "string",
        hasWindows: Array.isArray(parsed.windows),
      });
      return null;
    }

    const windows: RuntimeLimitWindow[] = [];
    for (const [index, window] of parsed.windows.entries()) {
      const normalized = parseRuntimeLimitWindow(window, entity, entityId, index, raw.length);
      if (!normalized) {
        return null;
      }
      windows.push(normalized);
    }

    const runtimeId = readStoredOptionalString(parsed, "runtimeId");
    const profileId = readStoredOptionalString(parsed, "profileId");
    const primaryScope = readStoredOptionalString(parsed, "primaryScope");
    const resetAt = readStoredOptionalString(parsed, "resetAt");
    const retryAfterSeconds = readStoredOptionalFiniteNumber(parsed, "retryAfterSeconds");
    const warningThreshold = readStoredOptionalFiniteNumber(parsed, "warningThreshold");
    const providerMeta = hasOwnProperty(parsed, "providerMeta")
      ? isObjectRecord(parsed.providerMeta)
        ? parsed.providerMeta
        : parsed.providerMeta == null
          ? null
          : undefined
      : undefined;

    return normalizeRuntimeLimitSnapshot({
      source: parsed.source as RuntimeLimitSnapshot["source"],
      status: parsed.status as RuntimeLimitSnapshot["status"],
      precision: parsed.precision as RuntimeLimitSnapshot["precision"],
      checkedAt: parsed.checkedAt,
      providerId: parsed.providerId,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      ...(profileId !== undefined ? { profileId } : {}),
      ...(primaryScope !== undefined
        ? { primaryScope: primaryScope as RuntimeLimitSnapshot["primaryScope"] }
        : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(warningThreshold !== undefined ? { warningThreshold } : {}),
      windows,
      ...(providerMeta !== undefined ? { providerMeta } : {}),
    });
  } catch (error) {
    warnMalformed("json_parse_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function serializeRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): string | null {
  return snapshot == null ? null : JSON.stringify(snapshot);
}

function parseAutoReviewState(raw: string | null | undefined): AutoReviewState | null {
  if (!raw) return null;

  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn({ reason, rawLength: raw.length, ...extra }, "Malformed persisted auto-review payload");
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
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(row.runtimeLimitSnapshotJson, row.id),
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
  | "blockedReason" | "blockedFromStatus" | "retryAfter" | "retryCount"
  | "reworkRequested" | "reviewIterationCount" | "maxReviewIterations" | "manualReviewRequired"
  | "runtimeLimitSnapshotJson" | "runtimeLimitUpdatedAt"
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
  retryAfter: tasks.retryAfter,
  retryCount: tasks.retryCount,
  reworkRequested: tasks.reworkRequested,
  reviewIterationCount: tasks.reviewIterationCount,
  maxReviewIterations: tasks.maxReviewIterations,
  manualReviewRequired: tasks.manualReviewRequired,
  runtimeLimitSnapshotJson: tasks.runtimeLimitSnapshotJson,
  runtimeLimitUpdatedAt: tasks.runtimeLimitUpdatedAt,
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
  const { tags, runtimeLimitSnapshotJson, ...rest } = row;
  return {
    ...rest,
    tags: parseTags(tags),
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(runtimeLimitSnapshotJson, row.id),
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

export function persistTaskRuntimeLimitSnapshot(
  taskId: string,
  snapshot: RuntimeLimitSnapshot,
  persistedAt = new Date().toISOString(),
): TaskRow | undefined {
  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  log.info(
    {
      taskId,
      status: normalizedSnapshot.status,
      source: normalizedSnapshot.source,
      precision: normalizedSnapshot.precision,
      resetAt: normalizedSnapshot.resetAt ?? null,
      persistedAt,
    },
    "Persisting task runtime limit snapshot",
  );
  getDb()
    .update(tasks)
    .set({
      runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(tasks.id, taskId))
    .run();
  return findTaskById(taskId);
}

export function clearTaskRuntimeLimitSnapshot(
  taskId: string,
  persistedAt = new Date().toISOString(),
): TaskRow | undefined {
  log.debug({ taskId, persistedAt }, "Clearing task runtime limit snapshot");
  getDb()
    .update(tasks)
    .set({
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(tasks.id, taskId))
    .run();
  return findTaskById(taskId);
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
  const db = getDb();
  // Migration 13 seeds row id=1. Keep this fallback for legacy/test databases
  // so read paths stay resilient even when they start from an empty schema.
  const existing = db.select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get();
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  log.debug({ appSettingsId: APP_SETTINGS_ID }, "Seeding missing singleton app settings row");
  db
    .insert(appSettings)
    .values({
      id: APP_SETTINGS_ID,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  return db.select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get()!;
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

  return ensureAppSettingsRow();
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

/**
 * Conditional proactive runtime gate block (CAS).
 * Applies the block only if the candidate row is still in the expected state
 * and remains available (unpaused + unlocked) at write time.
 */
export function blockTaskForRuntimeGateIfEligible(input: {
  taskId: string;
  expectedProjectId?: string | null;
  expectedStatus: TaskStatus;
  expectedAutoMode?: boolean;
  blockedFromStatus: TaskStatus;
  blockedReason: string;
  retryAfter: string | null;
  retryCount: number;
  snapshot: RuntimeLimitSnapshot | null;
  persistedAt?: string;
}): boolean {
  const nowIso = input.persistedAt ?? new Date().toISOString();
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const conditions = [
    eq(tasks.id, input.taskId),
    eq(tasks.status, input.expectedStatus),
    eq(tasks.paused, false),
    or(sql`${tasks.lockedBy} IS NULL`, lte(tasks.lockedUntil, nowIso)),
  ];
  if (input.expectedProjectId != null) {
    conditions.push(eq(tasks.projectId, input.expectedProjectId));
  }
  if (input.expectedAutoMode != null) {
    conditions.push(eq(tasks.autoMode, input.expectedAutoMode));
  }

  const result = getDb()
    .update(tasks)
    .set({
      status: "blocked_external",
      blockedFromStatus: input.blockedFromStatus,
      blockedReason: input.blockedReason,
      retryAfter: input.retryAfter,
      retryCount: input.retryCount,
      runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
      runtimeLimitUpdatedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(...conditions))
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

export interface CreateDbUsageSinkOptions {
  onRecorded?: (event: DbUsageEvent) => void;
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
export function createDbUsageSink(options: CreateDbUsageSinkOptions = {}): DbUsageSink {
  return {
    record(event) {
      try {
        recordUsageEvent(event);
        try {
          options.onRecorded?.(event);
        } catch (callbackError) {
          log.warn(
            {
              err: callbackError,
              runtimeId: event.runtimeId,
              source: event.context.source,
            },
            "Usage sink onRecorded callback failed",
          );
        }
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

function findLatestRuntimeProfileUsageByIds(
  profileIds: string[],
): Map<string, RuntimeProfileUsageState> {
  const uniqueProfileIds = Array.from(new Set(profileIds.filter((value) => value.length > 0)));
  if (uniqueProfileIds.length === 0) {
    return new Map();
  }

  const db = getDb();
  const latestUsageByProfile = db
    .select({
      profileId: usageEvents.profileId,
      latestCreatedAt: max(usageEvents.createdAt).as("latest_created_at"),
    })
    .from(usageEvents)
    .where(and(isNotNull(usageEvents.profileId), inArray(usageEvents.profileId, uniqueProfileIds)))
    .groupBy(usageEvents.profileId)
    .as("latest_usage_by_profile");

  const rows = db
    .select({
      profileId: usageEvents.profileId,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      totalTokens: usageEvents.totalTokens,
      costUsd: usageEvents.costUsd,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(
      latestUsageByProfile,
      and(
        eq(usageEvents.profileId, latestUsageByProfile.profileId),
        eq(usageEvents.createdAt, latestUsageByProfile.latestCreatedAt),
      ),
    )
    .all();

  const usageByProfileId = new Map<string, RuntimeProfileUsageState>();
  for (const row of rows) {
    if (!row.profileId) continue;
    if (usageByProfileId.has(row.profileId)) continue;
    usageByProfileId.set(row.profileId, {
      lastUsage: toRuntimeProfileUsage(row),
      lastUsageAt: row.createdAt,
    });
  }

  return usageByProfileId;
}

export function toRuntimeProfileResponse(
  row: RuntimeProfileRow,
  usageState: RuntimeProfileUsageState | null = null,
): RuntimeProfile {
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
    runtimeLimitSnapshot: parseRuntimeLimitSnapshot(
      row.runtimeLimitSnapshotJson,
      "runtime_profile",
      row.id,
    ),
    runtimeLimitUpdatedAt: row.runtimeLimitUpdatedAt ?? null,
    lastUsage: usageState?.lastUsage ?? null,
    lastUsageAt: usageState?.lastUsageAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findRuntimeProfileById(id: string): RuntimeProfileRow | undefined {
  return getDb().select().from(runtimeProfiles).where(eq(runtimeProfiles.id, id)).get();
}

export function getRuntimeProfileResponseById(id: string): RuntimeProfile | undefined {
  const row = findRuntimeProfileById(id);
  if (!row) return undefined;
  const usageState = findLatestRuntimeProfileUsageByIds([id]).get(id) ?? null;
  return toRuntimeProfileResponse(row, usageState);
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

export function listRuntimeProfileResponses(input: {
  projectId?: string;
  includeGlobal?: boolean;
  enabledOnly?: boolean;
} = {}): RuntimeProfile[] {
  const rows = listRuntimeProfiles(input);
  const usageByProfileId = findLatestRuntimeProfileUsageByIds(rows.map((row) => row.id));
  return rows.map((row) => toRuntimeProfileResponse(row, usageByProfileId.get(row.id) ?? null));
}

function getProjectRuntimeProfileId(
  project: ProjectRow | undefined,
  mode: "task" | "plan" | "review" | "chat",
): string | null {
  if (mode === "chat") {
    return project?.defaultChatRuntimeProfileId ?? null;
  }
  if (mode === "plan") {
    return project?.defaultPlanRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  }
  if (mode === "review") {
    return project?.defaultReviewRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  }
  return project?.defaultTaskRuntimeProfileId ?? null;
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

export function persistRuntimeProfileLimitSnapshot(
  runtimeProfileId: string,
  snapshot: RuntimeLimitSnapshot,
  persistedAt = new Date().toISOString(),
): RuntimeProfileRow | undefined {
  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  log.info(
    {
      runtimeProfileId,
      status: normalizedSnapshot.status,
      source: normalizedSnapshot.source,
      precision: normalizedSnapshot.precision,
      resetAt: normalizedSnapshot.resetAt ?? null,
      persistedAt,
    },
    "Persisting runtime profile limit snapshot",
  );
  getDb()
    .update(runtimeProfiles)
    .set({
      runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(runtimeProfiles.id, runtimeProfileId))
    .run();
  return findRuntimeProfileById(runtimeProfileId);
}

export function clearRuntimeProfileLimitSnapshot(
  runtimeProfileId: string,
  persistedAt = new Date().toISOString(),
): RuntimeProfileRow | undefined {
  log.debug({ runtimeProfileId, persistedAt }, "Clearing runtime profile limit snapshot");
  getDb()
    .update(runtimeProfiles)
    .set({
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(runtimeProfiles.id, runtimeProfileId))
    .run();
  return findRuntimeProfileById(runtimeProfileId);
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

export interface RuntimeLimitGateDecision {
  blocked: boolean;
  reason: "none" | "provider_blocked" | "exact_threshold";
  runtimeProfileId: string | null;
  snapshot: RuntimeLimitSnapshot | null;
  futureHint: RuntimeLimitFutureHint;
  violatedWindow: RuntimeLimitWindow | null;
  signature: string | null;
}

export function evaluateRuntimeLimitGate(
  profile: RuntimeProfile | null | undefined,
  nowMs = Date.now(),
): RuntimeLimitGateDecision {
  const snapshot = profile?.runtimeLimitSnapshot ?? null;
  const runtimeProfileId = profile?.id ?? null;
  if (!snapshot) {
    return {
      blocked: false,
      reason: "none",
      runtimeProfileId,
      snapshot: null,
      futureHint: resolveRuntimeLimitFutureHint(null, { nowMs }),
      violatedWindow: null,
      signature: null,
    };
  }

  const signature = buildRuntimeLimitSignature(snapshot);
  const providerBlockedHint = resolveRuntimeLimitFutureHint(snapshot, { nowMs });

  if (snapshot.status === "blocked" && providerBlockedHint.source === "none") {
    log.debug(
      {
        runtimeProfileId,
        status: snapshot.status,
        precision: snapshot.precision,
        checkedAt: snapshot.checkedAt,
        signature,
      },
      "Skipping proactive runtime gate because the persisted snapshot has no reset hint",
    );
  }
  if (snapshot.status === "blocked" && providerBlockedHint.isFuture) {
    return {
      blocked: true,
      reason: "provider_blocked",
      runtimeProfileId,
      snapshot,
      futureHint: providerBlockedHint,
      violatedWindow: null,
      signature,
    };
  }

  const violatedWindow = selectViolatedWindowForExactThreshold(snapshot, null, nowMs);
  const exactThresholdReached =
    snapshot.precision === "exact" && snapshot.status === "warning" && violatedWindow != null;
  const exactThresholdHint = resolveRuntimeLimitFutureHint(snapshot, {
    nowMs,
    preferredWindow: violatedWindow,
    windowFirst: true,
  });

  if (exactThresholdReached && exactThresholdHint.source === "none") {
    log.debug(
      {
        runtimeProfileId,
        status: snapshot.status,
        precision: snapshot.precision,
        checkedAt: snapshot.checkedAt,
        signature,
      },
      "Skipping proactive exact-threshold gate because the violated window has no reset hint",
    );
  }

  if (exactThresholdReached && exactThresholdHint.isFuture) {
    return {
      blocked: true,
      reason: "exact_threshold",
      runtimeProfileId,
      snapshot,
      futureHint: exactThresholdHint,
      violatedWindow,
      signature,
    };
  }

  return {
    blocked: false,
    reason: "none",
    runtimeProfileId,
    snapshot,
    futureHint: providerBlockedHint,
    violatedWindow: violatedWindow ?? null,
    signature,
  };
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

  const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
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

    if (candidate.source !== "task_override" && unavailableIds.length > 0) {
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
      profile: toRuntimeProfileResponse(
        profile,
        findLatestRuntimeProfileUsageByIds([profile.id]).get(profile.id) ?? null,
      ),
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

// ── Runtime Profile Resolution ─────────────────────────────────

type RuntimeResolvableTask = Pick<TaskRow, "id" | "projectId" | "runtimeProfileId">;

export function resolveEffectiveRuntimeProfilesForTasks(
  taskRows: RuntimeResolvableTask[],
  input: {
    mode?: "task" | "plan" | "review" | "chat";
    systemDefaultRuntimeProfileId?: string | null;
  } = {},
): Map<string, EffectiveRuntimeProfileSelection> {
  const mode = input.mode ?? "task";
  const systemRuntimeProfileId = input.systemDefaultRuntimeProfileId ?? null;
  const results = new Map<string, EffectiveRuntimeProfileSelection>();
  if (taskRows.length === 0) {
    return results;
  }

  const db = getDb();
  const projectIds = Array.from(new Set(taskRows.map((task) => task.projectId)));
  const projectRows =
    projectIds.length > 0
      ? db.select().from(projects).where(inArray(projects.id, projectIds)).all()
      : [];
  const projectById = new Map(projectRows.map((project) => [project.id, project]));

  const candidatesByTaskId = new Map<
    string,
    Array<{
      source: EffectiveRuntimeProfileSelection["source"];
      profileId: string | null;
    }>
  >();
  const profileIds = new Set<string>();

  for (const task of taskRows) {
    const project = projectById.get(task.projectId);
    const taskRuntimeProfileId = task.runtimeProfileId ?? null;
    const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
    const candidates: Array<{
      source: EffectiveRuntimeProfileSelection["source"];
      profileId: string | null;
    }> = [
      { source: "task_override", profileId: taskRuntimeProfileId },
      { source: "project_default", profileId: projectRuntimeProfileId },
      { source: "system_default", profileId: systemRuntimeProfileId },
    ];
    candidatesByTaskId.set(task.id, candidates);

    for (const candidate of candidates) {
      if (candidate.profileId) {
        profileIds.add(candidate.profileId);
      }
    }
  }

  const uniqueProfileIds = Array.from(profileIds);
  const profileRows =
    uniqueProfileIds.length > 0
      ? db.select().from(runtimeProfiles).where(inArray(runtimeProfiles.id, uniqueProfileIds)).all()
      : [];
  const profileById = new Map(profileRows.map((profile) => [profile.id, profile]));
  const usageByProfileId = findLatestRuntimeProfileUsageByIds(uniqueProfileIds);

  let fallbackLogCount = 0;
  for (const task of taskRows) {
    const project = projectById.get(task.projectId);
    const taskRuntimeProfileId = task.runtimeProfileId ?? null;
    const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
    const candidates = candidatesByTaskId.get(task.id) ?? [];
    const unavailableIds: string[] = [];

    for (const candidate of candidates) {
      if (!candidate.profileId) continue;
      const profile = profileById.get(candidate.profileId);
      if (!profile || !profile.enabled) {
        unavailableIds.push(candidate.profileId);
        continue;
      }

      if (candidate.source !== "task_override" && unavailableIds.length > 0) {
        fallbackLogCount += 1;
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

      results.set(task.id, {
        source: candidate.source,
        profile: toRuntimeProfileResponse(
          profile,
          usageByProfileId.get(profile.id) ?? null,
        ),
        taskRuntimeProfileId,
        projectRuntimeProfileId,
        systemRuntimeProfileId,
      });
      break;
    }

    if (!results.has(task.id)) {
      results.set(task.id, {
        source: "none",
        profile: null,
        taskRuntimeProfileId,
        projectRuntimeProfileId,
        systemRuntimeProfileId,
      });
    }
  }

  log.debug(
    {
      taskCount: taskRows.length,
      projectCount: projectById.size,
      candidateProfileCount: profileById.size,
      fallbackLogCount,
    },
    "[FIX:tasks-runtime-batch] Resolved effective runtime profiles for task list",
  );

  return results;
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

// - Codex index repository (session read-model + limit overlays) -

export interface UpsertCodexSessionInput {
  sessionId: string;
  filePath: string;
  title?: string | null;
  projectRoot?: string | null;
  accountFingerprint?: string | null;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  messageCount?: number;
  previewText?: string | null;
  sizeBytes: number;
  mtimeMs: number;
  lastIndexedAt?: string;
}

export interface UpsertCodexSessionFileInput {
  filePath: string;
  sessionId?: string | null;
  sizeBytes: number;
  mtimeMs: number;
  parsedOffset: number;
  pendingTail?: string;
  missing: boolean;
  importVersion: number;
  lastSeenAt?: string;
}

export interface UpsertCodexLimitHeadInput {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
  source?: string;
  snapshot: RuntimeLimitSnapshot;
  observedAt: string;
  sessionId?: string | null;
  filePath?: string | null;
}

export interface AppendCodexLimitHistoryInput {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
  snapshot: RuntimeLimitSnapshot;
  observedAt: string;
  sessionId?: string | null;
  filePath?: string | null;
  headKey?: string;
}

export interface CodexIndexCursorValue {
  cursorKey: string;
  cursorValue: string | null;
  cursorJson: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ListCodexLimitHeadsForOverlayInput {
  accountFingerprint: string;
  projectRoot: string | null;
  includeGlobalFallback?: boolean;
  limitId?: string | null;
  model?: string | null;
  limit?: number;
}

export interface CodexLimitHeadWithSnapshot {
  headKey: string;
  accountFingerprint: string;
  projectRoot: string | null;
  limitId: string;
  model: string | null;
  source: string;
  snapshot: RuntimeLimitSnapshot | null;
  observedAt: string;
  sessionId: string | null;
  filePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexLimitHeadScopeRow {
  headKey: string;
  projectRoot: string | null;
  observedAt: string;
  filePath: string | null;
}

function normalizeCodexProjectRoot(projectRoot: string | null | undefined): string | null {
  if (typeof projectRoot !== "string") return null;
  const trimmed = projectRoot.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function sanitizeCodexCount(value: number | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function parseCodexCursorJson(
  raw: string | null | undefined,
  cursorKey: string,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      log.warn({ cursorKey }, "Malformed codex index cursor JSON payload");
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(
      {
        cursorKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to parse codex index cursor JSON payload",
    );
    return null;
  }
}

function mapCodexLimitHeadWithSnapshot(row: CodexLimitHeadIndexRow): CodexLimitHeadWithSnapshot {
  return {
    headKey: row.headKey,
    accountFingerprint: row.accountFingerprint,
    projectRoot: row.projectRoot,
    limitId: row.limitId,
    model: row.model,
    source: row.source,
    snapshot: parseRuntimeLimitSnapshot(row.snapshotJson, "codex_limit_head", row.headKey),
    observedAt: row.observedAt,
    sessionId: row.sessionId,
    filePath: row.filePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function buildCodexLimitHeadKey(input: {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
}): string {
  return JSON.stringify([
    input.accountFingerprint,
    normalizeCodexProjectRoot(input.projectRoot) ?? "",
    input.limitId,
    input.model ?? "",
  ]);
}

// SQLite default SQLITE_MAX_VARIABLE_NUMBER is 999. Each row binds N columns,
// so bulk writes must chunk to stay under the limit. Without chunking the
// indexer warm-up crashes with "too many SQL variables" on any real
// ~/.codex/sessions (thousands of rollouts).
const CODEX_SESSION_UPSERT_BATCH = 50; // 14 cols × 50 = 700
const CODEX_SESSION_FILE_UPSERT_BATCH = 70; // 11 cols × 70 = 770
const CODEX_LIMIT_HEAD_UPSERT_BATCH = 70; // 12 cols × 70 = 840
const CODEX_LIMIT_HISTORY_INSERT_BATCH = 90; // 10 cols × 90 = 900
const CODEX_FILEPATH_IN_ARRAY_BATCH = 500; // single-column inArray

export function upsertCodexSessions(rows: UpsertCodexSessionInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex session upsert (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    sessionId: row.sessionId,
    filePath: row.filePath,
    title: row.title ?? null,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    accountFingerprint: row.accountFingerprint ?? null,
    sourceCreatedAt: row.sourceCreatedAt ?? null,
    sourceUpdatedAt: row.sourceUpdatedAt ?? null,
    messageCount: sanitizeCodexCount(row.messageCount, 0),
    previewText: row.previewText ?? null,
    sizeBytes: sanitizeCodexCount(row.sizeBytes, 0),
    mtimeMs: sanitizeCodexCount(row.mtimeMs, 0),
    lastIndexedAt: row.lastIndexedAt ?? nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_SESSION_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_SESSION_UPSERT_BATCH);
    const result = getDb()
      .insert(codexSessions)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexSessions.sessionId,
        set: {
          filePath: sql`excluded.file_path`,
          title: sql`excluded.title`,
          projectRoot: sql`excluded.project_root`,
          accountFingerprint: sql`excluded.account_fingerprint`,
          sourceCreatedAt: sql`excluded.source_created_at`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          messageCount: sql`excluded.message_count`,
          previewText: sql`excluded.preview_text`,
          sizeBytes: sql`excluded.size_bytes`,
          mtimeMs: sql`excluded.mtime_ms`,
          lastIndexedAt: sql`excluded.last_indexed_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex session index batch",
  );
  return totalChanges;
}

export function upsertCodexSessionFiles(rows: UpsertCodexSessionFileInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex session-file upsert (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    filePath: row.filePath,
    sessionId: row.sessionId ?? null,
    sizeBytes: sanitizeCodexCount(row.sizeBytes, 0),
    mtimeMs: sanitizeCodexCount(row.mtimeMs, 0),
    parsedOffset: sanitizeCodexCount(row.parsedOffset, 0),
    pendingTail: row.pendingTail ?? "",
    missing: row.missing,
    importVersion: sanitizeCodexCount(row.importVersion, 1),
    lastSeenAt: row.lastSeenAt ?? nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_SESSION_FILE_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_SESSION_FILE_UPSERT_BATCH);
    const result = getDb()
      .insert(codexSessionFiles)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexSessionFiles.filePath,
        set: {
          sessionId: sql`excluded.session_id`,
          sizeBytes: sql`excluded.size_bytes`,
          mtimeMs: sql`excluded.mtime_ms`,
          parsedOffset: sql`excluded.parsed_offset`,
          pendingTail: sql`excluded.pending_tail`,
          missing: sql`excluded.missing`,
          importVersion: sql`excluded.import_version`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex session-file index batch",
  );
  return totalChanges;
}

export function listCodexSessionFileStates(): CodexSessionFileIndexRow[] {
  const rows = getDb()
    .select()
    .from(codexSessionFiles)
    .orderBy(desc(codexSessionFiles.updatedAt))
    .all();
  log.debug({ returnedCount: rows.length }, "Listed codex session-file index state rows");
  return rows;
}

export function listCodexSessionFileStatesByPaths(filePaths: string[]): CodexSessionFileIndexRow[] {
  if (filePaths.length === 0) {
    return [];
  }

  const all: CodexSessionFileIndexRow[] = [];
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const rows = getDb()
      .select()
      .from(codexSessionFiles)
      .where(inArray(codexSessionFiles.filePath, chunk))
      .all();
    all.push(...rows);
  }
  log.debug(
    { requestedCount: filePaths.length, returnedCount: all.length },
    "Listed codex session-file index rows by file path",
  );
  return all;
}

export function deleteCodexSessionsByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexSessions)
      .where(inArray(codexSessions.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex indexed sessions by file paths",
  );
  return totalChanges;
}

export function listCodexLimitHeadScopesByFilePaths(
  filePaths: string[],
): CodexLimitHeadScopeRow[] {
  if (filePaths.length === 0) {
    return [];
  }
  const all: CodexLimitHeadScopeRow[] = [];
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const rows = getDb()
      .select({
        headKey: codexLimitHeads.headKey,
        projectRoot: codexLimitHeads.projectRoot,
        observedAt: codexLimitHeads.observedAt,
        filePath: codexLimitHeads.filePath,
      })
      .from(codexLimitHeads)
      .where(inArray(codexLimitHeads.filePath, chunk))
      .all();
    all.push(...rows);
  }
  log.debug(
    { requestedCount: filePaths.length, returnedCount: all.length },
    "Listed codex limit-head scopes by file paths",
  );
  return all;
}

export function deleteCodexLimitHeadsByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHeads)
      .where(inArray(codexLimitHeads.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex limit-head rows by file paths",
  );
  return totalChanges;
}

export function deleteCodexLimitHistoryByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHistory)
      .where(inArray(codexLimitHistory.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex limit-history rows by file paths",
  );
  return totalChanges;
}

export function upsertCodexLimitHeads(rows: UpsertCodexLimitHeadInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex limit-head upsert (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    headKey: buildCodexLimitHeadKey(row),
    accountFingerprint: row.accountFingerprint,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    limitId: row.limitId,
    model: row.model ?? null,
    source: row.source ?? "codex",
    snapshotJson: JSON.stringify(row.snapshot),
    observedAt: row.observedAt,
    sessionId: row.sessionId ?? null,
    filePath: row.filePath ?? null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_LIMIT_HEAD_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_LIMIT_HEAD_UPSERT_BATCH);
    const result = getDb()
      .insert(codexLimitHeads)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexLimitHeads.headKey,
        set: {
          accountFingerprint: sql`excluded.account_fingerprint`,
          projectRoot: sql`excluded.project_root`,
          limitId: sql`excluded.limit_id`,
          model: sql`excluded.model`,
          source: sql`excluded.source`,
          snapshotJson: sql`excluded.snapshot_json`,
          observedAt: sql`excluded.observed_at`,
          sessionId: sql`excluded.session_id`,
          filePath: sql`excluded.file_path`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex limit-head index batch",
  );
  return totalChanges;
}

export function appendCodexLimitHistory(rows: AppendCodexLimitHistoryInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex limit-history append (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    headKey: row.headKey ?? buildCodexLimitHeadKey(row),
    accountFingerprint: row.accountFingerprint,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    limitId: row.limitId,
    model: row.model ?? null,
    snapshotJson: JSON.stringify(row.snapshot),
    observedAt: row.observedAt,
    sessionId: row.sessionId ?? null,
    filePath: row.filePath ?? null,
    createdAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_LIMIT_HISTORY_INSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_LIMIT_HISTORY_INSERT_BATCH);
    const result = getDb().insert(codexLimitHistory).values(chunk).run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Appended codex limit-history rows",
  );
  return totalChanges;
}

export function pruneCodexLimitHistoryByHead(input: {
  headKey: string;
  keepLatest: number;
}): number {
  const keepLatest = sanitizeCodexCount(input.keepLatest, 0);
  const ids = getDb()
    .select({ id: codexLimitHistory.id })
    .from(codexLimitHistory)
    .where(eq(codexLimitHistory.headKey, input.headKey))
    .orderBy(desc(codexLimitHistory.observedAt), desc(codexLimitHistory.id))
    .all();

  const staleIds = ids.slice(keepLatest).map((row) => row.id);
  if (staleIds.length === 0) {
    log.debug(
      { candidateRows: ids.length, keepLatest, deletedRows: 0 },
      "Pruned codex limit-history rows",
    );
    return 0;
  }

  let deleted = 0;
  for (let i = 0; i < staleIds.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = staleIds.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHistory)
      .where(inArray(codexLimitHistory.id, chunk))
      .run();
    deleted += result.changes;
  }
  log.debug(
    {
      candidateRows: ids.length,
      keepLatest,
      deletedRows: deleted,
    },
    "Pruned codex limit-history rows",
  );
  return deleted;
}

export function pruneCodexLimitHistoryRetention(maxRowsPerHead: number): number {
  const keepLatest = sanitizeCodexCount(maxRowsPerHead, 0);
  const headRows = getDb()
    .select({ headKey: codexLimitHistory.headKey })
    .from(codexLimitHistory)
    .groupBy(codexLimitHistory.headKey)
    .all();

  let deletedRows = 0;
  for (const row of headRows) {
    deletedRows += pruneCodexLimitHistoryByHead({ headKey: row.headKey, keepLatest });
  }

  log.debug(
    { headCount: headRows.length, keepLatest, deletedRows },
    "Completed codex limit-history retention cleanup",
  );
  return deletedRows;
}

export function upsertCodexIndexCursor(input: {
  cursorKey: string;
  cursorValue?: string | null;
  cursorJson?: Record<string, unknown> | null;
  updatedAt?: string;
}): CodexIndexCursorValue | undefined {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const cursorJson = input.cursorJson == null ? null : JSON.stringify(input.cursorJson);
  getDb()
    .insert(codexIndexCursors)
    .values({
      cursorKey: input.cursorKey,
      cursorValue: input.cursorValue ?? null,
      cursorJson,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: codexIndexCursors.cursorKey,
      set: {
        cursorValue: sql`excluded.cursor_value`,
        cursorJson: sql`excluded.cursor_json`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();

  log.debug({ cursorKey: input.cursorKey }, "Upserted codex index cursor");
  return findCodexIndexCursor(input.cursorKey);
}

export function findCodexIndexCursor(cursorKey: string): CodexIndexCursorValue | undefined {
  const row = getDb()
    .select()
    .from(codexIndexCursors)
    .where(eq(codexIndexCursors.cursorKey, cursorKey))
    .get();
  if (!row) return undefined;

  return {
    cursorKey: row.cursorKey,
    cursorValue: row.cursorValue,
    cursorJson: parseCodexCursorJson(row.cursorJson, row.cursorKey),
    updatedAt: row.updatedAt,
  };
}

export function listCodexSessionsByProjectRoot(input: {
  projectRoot: string | null;
  limit?: number;
}): CodexSessionIndexRow[] {
  const limit = sanitizeCodexCount(input.limit, 20);
  const projectRoot = normalizeCodexProjectRoot(input.projectRoot);
  const whereClause =
    projectRoot == null ? isNull(codexSessions.projectRoot) : eq(codexSessions.projectRoot, projectRoot);

  const rows = getDb()
    .select()
    .from(codexSessions)
    .where(whereClause)
    .orderBy(desc(codexSessions.sourceUpdatedAt), desc(codexSessions.mtimeMs), desc(codexSessions.updatedAt))
    .limit(limit)
    .all();

  log.debug(
    { scope: projectRoot == null ? "global" : "project", requestedLimit: limit, returnedCount: rows.length },
    "Listed codex indexed sessions for project scope",
  );
  return rows;
}

export function findCodexSessionFilePathBySessionId(sessionId: string): string | null {
  const sessionRow = getDb()
    .select({ filePath: codexSessions.filePath })
    .from(codexSessions)
    .where(eq(codexSessions.sessionId, sessionId))
    .get();
  if (sessionRow?.filePath) {
    log.debug({ sessionId, source: "codex_sessions", hit: true }, "Resolved codex session file path");
    return sessionRow.filePath;
  }

  const fileRow = getDb()
    .select({ filePath: codexSessionFiles.filePath })
    .from(codexSessionFiles)
    .where(eq(codexSessionFiles.sessionId, sessionId))
    .orderBy(desc(codexSessionFiles.updatedAt))
    .get();

  const filePath = fileRow?.filePath ?? null;
  log.debug(
    { sessionId, source: "codex_session_files", hit: filePath != null },
    "Resolved codex session file path",
  );
  return filePath;
}

export function listCodexLimitHeadsForOverlay(
  input: ListCodexLimitHeadsForOverlayInput,
): CodexLimitHeadWithSnapshot[] {
  const projectRoot = normalizeCodexProjectRoot(input.projectRoot);
  const includeGlobalFallback = input.includeGlobalFallback ?? true;
  const limit = sanitizeCodexCount(input.limit, 20);
  const predicates = [eq(codexLimitHeads.accountFingerprint, input.accountFingerprint)];

  if (input.limitId != null) {
    predicates.push(eq(codexLimitHeads.limitId, input.limitId));
  }
  if (input.model != null) {
    predicates.push(eq(codexLimitHeads.model, input.model));
  }

  if (projectRoot == null) {
    predicates.push(isNull(codexLimitHeads.projectRoot));
  } else if (includeGlobalFallback) {
    predicates.push(
      or(eq(codexLimitHeads.projectRoot, projectRoot), isNull(codexLimitHeads.projectRoot))!,
    );
  } else {
    predicates.push(eq(codexLimitHeads.projectRoot, projectRoot));
  }

  const whereClause = and(...predicates);
  const scopeOrder =
    projectRoot == null
      ? [desc(codexLimitHeads.observedAt), desc(codexLimitHeads.updatedAt)]
      : [
          desc(
            sql<number>`case when ${codexLimitHeads.projectRoot} = ${projectRoot} then 1 else 0 end`,
          ),
          desc(codexLimitHeads.observedAt),
          desc(codexLimitHeads.updatedAt),
        ];

  const rows = getDb()
    .select()
    .from(codexLimitHeads)
    .where(whereClause)
    .orderBy(...scopeOrder)
    .limit(limit)
    .all();

  const mapped = rows.map(mapCodexLimitHeadWithSnapshot);
  log.debug(
    {
      scope: projectRoot == null ? "global" : "project",
      includeGlobalFallback,
      requestedLimit: limit,
      returnedCount: mapped.length,
    },
    "Listed codex limit-head overlay rows",
  );
  return mapped;
}

export function findPreferredCodexLimitHeadForOverlay(
  input: ListCodexLimitHeadsForOverlayInput,
): CodexLimitHeadWithSnapshot | null {
  const rows = listCodexLimitHeadsForOverlay({ ...input, limit: input.limit ?? 20 });
  for (const row of rows) {
    if (row.snapshot) {
      log.debug(
        {
          scope: row.projectRoot == null ? "global" : "project",
          limitId: row.limitId,
        },
        "Resolved preferred codex limit-head overlay row",
      );
      return row;
    }
  }
  log.debug(
    {
      scope: normalizeCodexProjectRoot(input.projectRoot) == null ? "global" : "project",
      limitId: input.limitId ?? null,
      model: input.model ?? null,
    },
    "No codex limit-head overlay row available",
  );
  return null;
}
