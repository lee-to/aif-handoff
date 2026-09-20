import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participants,
  taskAssignments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
  type ExecutionOwner,
  type TaskAssigneeSummary,
  type TaskExecutorHistoryEntry,
  type TaskOwnership,
  type TaskEvent,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

const log = logger("data:task-ownership");

export interface TaskOwnershipFilters {
  executionOwner?: ExecutionOwner;
  assigneeId?: string;
  currentParticipantId?: string;
  unassigned?: boolean;
}

export interface HandoffTaskExecutionInput {
  taskId: string;
  executionOwner: ExecutionOwner;
  assigneeIds?: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner;
  expectedStatus?: TaskStatus;
  actor: AuditActor;
  reason?: string | null;
  resumeAction?: TaskEvent;
  allowLockedBy?: string;
  now?: Date;
}

export type HandoffTaskExecutionConflictCode =
  | "not_found"
  | "locked"
  | "revision_conflict"
  | "inactive_assignee"
  | "invalid_transition";

export type HandoffTaskExecutionResult =
  | {
      ok: true;
      ownership: TaskOwnership;
      history: TaskExecutorHistoryEntry;
    }
  | {
      ok: false;
      code: HandoffTaskExecutionConflictCode;
      ownership?: TaskOwnership;
    };

type AssigneeMap = Map<string, TaskAssigneeSummary[]>;

function parseHistoryAssignees(raw: string): TaskAssigneeSummary[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
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
    return [];
  }
}

function toHistoryEntry(
  row: typeof taskExecutorHistory.$inferSelect,
): TaskExecutorHistoryEntry {
  return {
    id: row.id,
    taskId: row.taskId,
    taskTitleSnapshot: row.taskTitleSnapshot,
    ownershipRevision: row.ownershipRevision,
    executionOwner: row.executionOwner,
    assignees: parseHistoryAssignees(row.assigneesSnapshotJson),
    statusSnapshot: row.statusSnapshot,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      displayNameSnapshot: row.actorDisplayNameSnapshot,
    },
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function sameAssignees(current: TaskAssigneeSummary[], requested: TaskAssigneeSummary[]): boolean {
  if (current.length !== requested.length) return false;
  const currentIds = current.map((assignee) => assignee.participantId).sort();
  const requestedIds = requested.map((assignee) => assignee.participantId).sort();
  return currentIds.every((participantId, index) => participantId === requestedIds[index]);
}

function hasLiveTaskLock(
  task: { lockedBy: string | null; lockedUntil: string | null },
  nowIso: string,
  allowLockedBy?: string,
): boolean {
  return Boolean(
    task.lockedBy &&
    task.lockedBy !== allowLockedBy &&
    (!task.lockedUntil || task.lockedUntil > nowIso),
  );
}

export function buildTaskOwnershipConditions(filters: TaskOwnershipFilters) {
  const participantId = filters.currentParticipantId ?? filters.assigneeId;
  return [
    filters.executionOwner
      ? eq(tasks.executionOwner, filters.executionOwner)
      : undefined,
    participantId
      ? sql`exists (
          select 1
          from ${taskAssignments}
          where ${taskAssignments.taskId} = ${tasks.id}
            and ${taskAssignments.participantId} = ${participantId}
        )`
      : undefined,
    filters.unassigned
      ? sql`not exists (
          select 1
          from ${taskAssignments}
          where ${taskAssignments.taskId} = ${tasks.id}
        )`
      : undefined,
  ].filter((condition) => condition !== undefined);
}

export function listTaskAssigneesByTaskIds(taskIds: string[]): AssigneeMap {
  const uniqueTaskIds = [...new Set(taskIds)];
  const result: AssigneeMap = new Map(uniqueTaskIds.map((taskId) => [taskId, []]));
  if (uniqueTaskIds.length === 0) return result;

  const rows = getDb()
    .select({
      taskId: taskAssignments.taskId,
      participantId: participants.id,
      displayName: participants.displayName,
      role: participants.role,
      active: participants.active,
    })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(inArray(taskAssignments.taskId, uniqueTaskIds))
    .orderBy(
      asc(taskAssignments.taskId),
      asc(participants.displayName),
      asc(participants.id),
    )
    .all();

  for (const row of rows) {
    result.get(row.taskId)?.push({
      participantId: row.participantId,
      displayName: row.displayName,
      role: row.role,
      active: row.active,
    });
  }
  log.debug(
    { taskCount: uniqueTaskIds.length, assignmentCount: rows.length },
    "Hydrated task assignees",
  );
  return result;
}

export function getTaskOwnership(taskId: string): TaskOwnership | null {
  const task = getDb()
    .select({
      executionOwner: tasks.executionOwner,
      ownershipRevision: tasks.ownershipRevision,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task) return null;
  return {
    ...task,
    assignees: listTaskAssigneesByTaskIds([taskId]).get(taskId) ?? [],
  };
}

export function listTaskExecutorHistory(taskId: string): TaskExecutorHistoryEntry[] {
  const rows = getDb()
    .select()
    .from(taskExecutorHistory)
    .where(eq(taskExecutorHistory.taskId, taskId))
    .orderBy(
      asc(taskExecutorHistory.ownershipRevision),
      asc(taskExecutorHistory.createdAt),
      asc(taskExecutorHistory.id),
    )
    .all();
  log.debug({ taskId, count: rows.length }, "Listed task executor history");
  return rows.map(toHistoryEntry);
}

export function handoffTaskExecution(
  input: HandoffTaskExecutionInput,
): HandoffTaskExecutionResult {
  const db = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requestedAssigneeIds = [...new Set(input.assigneeIds ?? [])];
  log.debug(
    {
      taskId: input.taskId,
      executionOwner: input.executionOwner,
      assigneeCount: requestedAssigneeIds.length,
      expectedOwnershipRevision: input.expectedOwnershipRevision,
      expectedExecutionOwner: input.expectedExecutionOwner ?? null,
      expectedStatus: input.expectedStatus ?? null,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
    },
    "Evaluating task execution handoff",
  );

  try {
    return db.transaction((tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task) {
        log.warn({ taskId: input.taskId, code: "not_found" }, "Task handoff rejected");
        return { ok: false, code: "not_found" } as const;
      }

      const currentAssignees = tx
        .select({
          participantId: participants.id,
          displayName: participants.displayName,
          role: participants.role,
          active: participants.active,
        })
        .from(taskAssignments)
        .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
        .where(eq(taskAssignments.taskId, task.id))
        .orderBy(asc(participants.displayName), asc(participants.id))
        .all();
      const currentOwnership: TaskOwnership = {
        executionOwner: task.executionOwner,
        ownershipRevision: task.ownershipRevision,
        assignees: currentAssignees,
      };
      const hasLiveLock = hasLiveTaskLock(task, nowIso, input.allowLockedBy);
      if (hasLiveLock) {
        log.warn(
          {
            taskId: task.id,
            code: "locked",
            lockedBy: task.lockedBy,
            lockedUntil: task.lockedUntil,
          },
          "Task handoff rejected",
        );
        return { ok: false, code: "locked", ownership: currentOwnership } as const;
      }

      const revisionMismatch =
        task.ownershipRevision !== input.expectedOwnershipRevision;
      const ownerMismatch =
        input.expectedExecutionOwner !== undefined &&
        task.executionOwner !== input.expectedExecutionOwner;
      const statusMismatch =
        input.expectedStatus !== undefined && task.status !== input.expectedStatus;
      if (revisionMismatch || ownerMismatch || statusMismatch) {
        log.warn(
          {
            taskId: task.id,
            code: "revision_conflict",
            expectedOwnershipRevision: input.expectedOwnershipRevision,
            actualOwnershipRevision: task.ownershipRevision,
            expectedExecutionOwner: input.expectedExecutionOwner ?? null,
            actualExecutionOwner: task.executionOwner,
            expectedStatus: input.expectedStatus ?? null,
            actualStatus: task.status,
          },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "revision_conflict",
          ownership: currentOwnership,
        } as const;
      }

      if (
        task.status === "verified" ||
        (input.executionOwner === "ai" && requestedAssigneeIds.length > 0) ||
        (task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "plan_ready" &&
          !task.autoMode &&
          input.resumeAction !== "start_implementation") ||
        (task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "blocked_external" &&
          (input.resumeAction !== "retry_from_blocked" || !task.blockedFromStatus))
      ) {
        log.warn(
          { taskId: task.id, code: "invalid_transition", status: task.status },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "invalid_transition",
          ownership: currentOwnership,
        } as const;
      }

      const requestedAssignees =
        requestedAssigneeIds.length === 0
          ? []
          : tx
              .select({
                participantId: participants.id,
                displayName: participants.displayName,
                role: participants.role,
                active: participants.active,
              })
              .from(participants)
              .where(inArray(participants.id, requestedAssigneeIds))
              .orderBy(asc(participants.displayName), asc(participants.id))
              .all();
      const hasInactiveOrMissingAssignee =
        requestedAssignees.length !== requestedAssigneeIds.length ||
        requestedAssignees.some((participant) => !participant.active);
      if (hasInactiveOrMissingAssignee) {
        log.warn(
          {
            taskId: task.id,
            code: "inactive_assignee",
            requestedAssigneeCount: requestedAssigneeIds.length,
            activeAssigneeCount: requestedAssignees.filter((assignee) => assignee.active).length,
          },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "inactive_assignee",
          ownership: currentOwnership,
        } as const;
      }

      if (
        task.executionOwner === input.executionOwner &&
        sameAssignees(currentAssignees, requestedAssignees)
      ) {
        log.warn(
          { taskId: task.id, code: "invalid_transition" },
          "Task handoff would not change ownership",
        );
        return {
          ok: false,
          code: "invalid_transition",
          ownership: currentOwnership,
        } as const;
      }

      const lockAvailable = input.allowLockedBy
        ? or(
            isNull(tasks.lockedBy),
            lte(tasks.lockedUntil, nowIso),
            eq(tasks.lockedBy, input.allowLockedBy),
          )
        : or(isNull(tasks.lockedBy), lte(tasks.lockedUntil, nowIso));
      const updated = tx
        .update(tasks)
        .set({
          executionOwner: input.executionOwner,
          ownershipRevision: sql`${tasks.ownershipRevision} + 1`,
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "backlog"
            ? {
                status: "planning" as const,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "plan_ready" &&
          !task.autoMode &&
          input.resumeAction === "start_implementation"
            ? {
                status: "implementing" as const,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "blocked_external" &&
          input.resumeAction === "retry_from_blocked" &&
          task.blockedFromStatus
            ? {
                status: task.blockedFromStatus,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.ownershipRevision, input.expectedOwnershipRevision),
            input.expectedExecutionOwner === undefined
              ? undefined
              : eq(tasks.executionOwner, input.expectedExecutionOwner),
            input.expectedStatus === undefined
              ? undefined
              : eq(tasks.status, input.expectedStatus),
            lockAvailable,
          ),
        )
        .returning({
          executionOwner: tasks.executionOwner,
          ownershipRevision: tasks.ownershipRevision,
          status: tasks.status,
        })
        .get();
      if (!updated) {
        const racedTask = tx
          .select({ lockedBy: tasks.lockedBy, lockedUntil: tasks.lockedUntil })
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .get();
        const code =
          racedTask && hasLiveTaskLock(racedTask, nowIso, input.allowLockedBy)
            ? "locked"
            : "revision_conflict";
        log.warn(
          { taskId: task.id, code, lockedBy: racedTask?.lockedBy ?? null },
          "Task handoff lost atomic update race",
        );
        return {
          ok: false,
          code,
          ownership: currentOwnership,
        } as const;
      }

      tx.delete(taskAssignments).where(eq(taskAssignments.taskId, task.id)).run();
      if (input.executionOwner === "human" && requestedAssignees.length > 0) {
        tx.insert(taskAssignments)
          .values(
            requestedAssignees.map((assignee) => ({
              taskId: task.id,
              participantId: assignee.participantId,
              assignedByKind: input.actor.kind,
              assignedById: input.actor.id,
              assignedByDisplayNameSnapshot: input.actor.displayNameSnapshot,
              createdAt: nowIso,
            })),
          )
          .run();
      }

      const ownership: TaskOwnership = {
        executionOwner: updated.executionOwner,
        ownershipRevision: updated.ownershipRevision,
        assignees: input.executionOwner === "human" ? requestedAssignees : [],
      };
      const historyRow = tx
        .insert(taskExecutorHistory)
        .values({
          id: crypto.randomUUID(),
          taskId: task.id,
          taskTitleSnapshot: task.title,
          ownershipRevision: ownership.ownershipRevision,
          executionOwner: ownership.executionOwner,
          assigneesSnapshotJson: JSON.stringify(ownership.assignees),
          statusSnapshot: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
          actorDisplayNameSnapshot: input.actor.displayNameSnapshot,
          reason: input.reason ?? null,
          createdAt: nowIso,
        })
        .returning()
        .get();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "task.execution_handoff",
            entityType: "task",
            entityId: task.id,
            taskId: task.id,
            taskTitleSnapshot: task.title,
            executionOwnerSnapshot: ownership.executionOwner,
            assigneesSnapshot: ownership.assignees,
            statusSnapshot: updated.status,
            actor: input.actor,
            reason: input.reason ?? null,
            metadata: {
              previousExecutionOwner: task.executionOwner,
              previousOwnershipRevision: task.ownershipRevision,
              previousStatus: task.status,
              ownershipRevision: ownership.ownershipRevision,
              status: updated.status,
            },
            createdAt: nowIso,
          }),
        )
        .run();
      log.info(
        {
          taskId: task.id,
          executionOwner: ownership.executionOwner,
          ownershipRevision: ownership.ownershipRevision,
          assigneeCount: ownership.assignees.length,
          status: updated.status,
        },
        "Task execution handoff completed",
      );
      return {
        ok: true,
        ownership,
        history: toHistoryEntry(historyRow),
      } as const;
    });
  } catch (error) {
    log.error(
      {
        error,
        taskId: input.taskId,
        expectedOwnershipRevision: input.expectedOwnershipRevision,
      },
      "Task execution handoff transaction failed",
    );
    throw error;
  }
}
