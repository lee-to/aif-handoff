import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  type AuditActor,
  type AuditEvent,
  type ExecutionOwner,
  type NewAuditEventRow,
  type TaskAssigneeSummary,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = logger("data:audit");

export interface AppendAuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  taskId?: string | null;
  taskTitleSnapshot?: string | null;
  participantId?: string | null;
  participantDisplayNameSnapshot?: string | null;
  executionOwnerSnapshot?: ExecutionOwner | null;
  assigneesSnapshot?: TaskAssigneeSummary[] | null;
  statusSnapshot?: TaskStatus | null;
  actor: AuditActor;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseAssignees(raw: string | null): TaskAssigneeSummary[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is TaskAssigneeSummary => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TaskAssigneeSummary>;
      return (
        typeof candidate.participantId === "string" &&
        typeof candidate.displayName === "string" &&
        (candidate.role === "admin" || candidate.role === "member") &&
        typeof candidate.active === "boolean"
      );
    });
  } catch {
    return null;
  }
}

function toAuditEvent(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    taskId: row.taskId,
    taskTitleSnapshot: row.taskTitleSnapshot,
    participantId: row.participantId,
    participantDisplayNameSnapshot: row.participantDisplayNameSnapshot,
    executionOwnerSnapshot: row.executionOwnerSnapshot,
    assigneesSnapshot: parseAssignees(row.assigneesSnapshotJson),
    statusSnapshot: row.statusSnapshot,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      displayNameSnapshot: row.actorDisplayNameSnapshot,
    },
    reason: row.reason,
    metadata: parseJsonRecord(row.metadataJson),
    createdAt: row.createdAt,
  };
}

export function createAuditEventValues(input: AppendAuditEventInput): NewAuditEventRow {
  return {
    id: crypto.randomUUID(),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    taskId: input.taskId ?? null,
    taskTitleSnapshot: input.taskTitleSnapshot ?? null,
    participantId: input.participantId ?? null,
    participantDisplayNameSnapshot: input.participantDisplayNameSnapshot ?? null,
    executionOwnerSnapshot: input.executionOwnerSnapshot ?? null,
    assigneesSnapshotJson:
      input.assigneesSnapshot === undefined || input.assigneesSnapshot === null
        ? null
        : JSON.stringify(input.assigneesSnapshot),
    statusSnapshot: input.statusSnapshot ?? null,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    actorDisplayNameSnapshot: input.actor.displayNameSnapshot,
    reason: input.reason ?? null,
    metadataJson:
      input.metadata === undefined || input.metadata === null
        ? null
        : JSON.stringify(input.metadata),
    createdAt: input.createdAt,
  };
}

export function appendAuditEvent(input: AppendAuditEventInput): AuditEvent {
  log.debug(
    {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      taskId: input.taskId ?? null,
      participantId: input.participantId ?? null,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
    },
    "Appending audit event",
  );
  const values = createAuditEventValues(input);

  try {
    const created = getDb().insert(auditEvents).values(values).returning().get();
    log.info(
      {
        auditEventId: created.id,
        action: created.action,
        entityType: created.entityType,
        entityId: created.entityId,
      },
      "Audit event appended",
    );
    return toAuditEvent(created);
  } catch (error) {
    log.error(
      {
        error,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
      },
      "Failed to append audit event",
    );
    throw error;
  }
}

export function listAuditEvents(input: {
  taskId?: string;
  participantId?: string;
}): AuditEvent[] {
  const predicates = [
    input.taskId ? eq(auditEvents.taskId, input.taskId) : undefined,
    input.participantId ? eq(auditEvents.participantId, input.participantId) : undefined,
  ].filter((predicate) => predicate !== undefined);
  const rows =
    predicates.length === 0
      ? getDb()
          .select()
          .from(auditEvents)
          .orderBy(asc(auditEvents.createdAt), sql`rowid`)
          .all()
      : getDb()
          .select()
          .from(auditEvents)
          .where(and(...predicates))
          .orderBy(asc(auditEvents.createdAt), sql`rowid`)
          .all();

  log.debug(
    {
      taskId: input.taskId ?? null,
      participantId: input.participantId ?? null,
      count: rows.length,
    },
    "Listed audit events",
  );
  return rows.map(toAuditEvent);
}
