import { and, asc, eq } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participants,
  resolveTaskAction,
  taskAssignments,
  tasks,
  type AuditActor,
  type AutoReviewState,
  type ParticipantRole,
  type TaskActionContext,
  type TaskAssigneeSummary,
  type TaskEvent,
  type TaskRow,
  type TaskStatus,
  type TransitionPatch,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

const log = logger("data:task-transitions");

export type TaskTransitionExtra = Partial<
  Omit<
    TaskRow,
    | "id"
    | "projectId"
    | "status"
    | "executionOwner"
    | "ownershipRevision"
    | "createdAt"
  >
> & {
  autoReviewState?: AutoReviewState | null;
};

export type TaskTransitionConflictCode =
  | "not_found"
  | "status_conflict"
  | "action_not_allowed"
  | "actor_not_authorized"
  | "assignment_required"
  | "ai_handoff_required"
  | "blocked_status_missing";

export type TaskTransitionResult =
  | { ok: true; task: TaskRow; fromStatus: TaskStatus; toStatus: TaskStatus }
  | {
      ok: false;
      code: TaskTransitionConflictCode;
      message: string;
      currentStatus?: TaskStatus;
    };

export interface TransitionTaskStatusInput {
  taskId: string;
  status: TaskStatus;
  expectedStatus?: TaskStatus;
  extra?: TaskTransitionExtra;
  actor: AuditActor;
  action?: string;
  reason?: string | null;
  now?: Date;
}

export interface ApplyTaskActionInput {
  taskId: string;
  event: TaskEvent;
  participantsModeEnabled: boolean;
  actor: AuditActor;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
  expectedStatus?: TaskStatus;
  extra?: TaskTransitionExtra;
  reason?: string | null;
  now?: Date;
}

function normalizeExtra(
  extra: TaskTransitionExtra | Omit<TransitionPatch, "status">,
): Partial<typeof tasks.$inferInsert> {
  const {
    autoReviewState,
    executionOwner: _executionOwner,
    ownershipRevision: _ownershipRevision,
    status: _status,
    id: _id,
    projectId: _projectId,
    createdAt: _createdAt,
    ...rest
  } = extra as TaskTransitionExtra & {
    executionOwner?: unknown;
    ownershipRevision?: unknown;
    status?: unknown;
    id?: unknown;
    projectId?: unknown;
    createdAt?: unknown;
  };
  return {
    ...rest,
    ...(autoReviewState === undefined
      ? {}
      : {
          autoReviewStateJson:
            autoReviewState === null ? null : JSON.stringify(autoReviewState),
        }),
  };
}

function listAssigneesInTransaction(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  taskId: string,
): TaskAssigneeSummary[] {
  return tx
    .select({
      participantId: participants.id,
      displayName: participants.displayName,
      role: participants.role,
      active: participants.active,
    })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(eq(taskAssignments.taskId, taskId))
    .orderBy(asc(participants.displayName), asc(participants.id))
    .all();
}

function appendTransitionAudit(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    task: TaskRow;
    assignees: TaskAssigneeSummary[];
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    actor: AuditActor;
    action: string;
    reason: string | null;
    createdAt: string;
  },
): void {
  tx.insert(auditEvents)
    .values(
      createAuditEventValues({
        action: input.action,
        entityType: "task",
        entityId: input.task.id,
        taskId: input.task.id,
        taskTitleSnapshot: input.task.title,
        executionOwnerSnapshot: input.task.executionOwner,
        assigneesSnapshot: input.assignees,
        statusSnapshot: input.toStatus,
        actor: input.actor,
        reason: input.reason,
        metadata: {
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          ownershipRevision: input.task.ownershipRevision,
        },
        createdAt: input.createdAt,
      }),
    )
    .run();
}

function statusConflict(task: TaskRow): TaskTransitionResult {
  return {
    ok: false,
    code: "status_conflict",
    message: "Task status changed before the transition could be applied",
    currentStatus: task.status,
  };
}

export function transitionTaskStatus(
  input: TransitionTaskStatusInput,
): TaskTransitionResult {
  const nowIso = (input.now ?? new Date()).toISOString();
  log.debug(
    {
      taskId: input.taskId,
      expectedStatus: input.expectedStatus ?? null,
      targetStatus: input.status,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: input.action ?? "task.status_changed",
    },
    "Evaluating atomic task status transition",
  );

  try {
    return getDb().transaction((tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task) {
        return { ok: false, code: "not_found", message: "Task not found" } as const;
      }
      if (input.expectedStatus !== undefined && task.status !== input.expectedStatus) {
        log.warn(
          {
            taskId: task.id,
            expectedStatus: input.expectedStatus,
            actualStatus: task.status,
            code: "status_conflict",
          },
          "Task status transition rejected",
        );
        return statusConflict(task);
      }
      if (input.actor.kind === "participant") {
        return {
          ok: false,
          code: "actor_not_authorized",
          message: "Participant transitions must use an explicit task action",
          currentStatus: task.status,
        } as const;
      }
      if (input.actor.kind === "agent" && task.executionOwner !== "ai") {
        return {
          ok: false,
          code: "ai_handoff_required",
          message: "The task must be handed to AI before an agent can change its status",
          currentStatus: task.status,
        } as const;
      }

      const assignees = listAssigneesInTransaction(tx, task.id);
      const updated = tx
        .update(tasks)
        .set({
          ...normalizeExtra(input.extra ?? {}),
          status: input.status,
          sessionId: null,
          lastHeartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.status, input.expectedStatus ?? task.status),
          ),
        )
        .returning()
        .get();
      if (!updated) return statusConflict(task);

      appendTransitionAudit(tx, {
        task,
        assignees,
        fromStatus: task.status,
        toStatus: updated.status,
        actor: input.actor,
        action: input.action ?? "task.status_changed",
        reason: input.reason ?? null,
        createdAt: nowIso,
      });
      log.info(
        {
          taskId: task.id,
          fromStatus: task.status,
          toStatus: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
        },
        "Task status transition committed",
      );
      return {
        ok: true,
        task: updated,
        fromStatus: task.status,
        toStatus: updated.status,
      } as const;
    });
  } catch (error) {
    log.error(
      {
        error,
        taskId: input.taskId,
        expectedStatus: input.expectedStatus ?? null,
        targetStatus: input.status,
      },
      "Task status transition transaction failed",
    );
    throw error;
  }
}

export function applyTaskAction(input: ApplyTaskActionInput): TaskTransitionResult {
  const nowIso = (input.now ?? new Date()).toISOString();
  log.debug(
    {
      taskId: input.taskId,
      event: input.event,
      expectedStatus: input.expectedStatus ?? null,
      participantsModeEnabled: input.participantsModeEnabled,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      participantRole: input.participantRole ?? null,
    },
    "Evaluating atomic task action",
  );

  try {
    return getDb().transaction((tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task) {
        return { ok: false, code: "not_found", message: "Task not found" } as const;
      }
      if (input.expectedStatus !== undefined && task.status !== input.expectedStatus) {
        return statusConflict(task);
      }

      const assignees = listAssigneesInTransaction(tx, task.id);
      const context: TaskActionContext = {
        participantsModeEnabled: input.participantsModeEnabled,
        actor: input.actor,
        participantRole: input.participantRole,
        participantActive: input.participantActive,
      };
      const resolution = resolveTaskAction(
        {
          status: task.status,
          autoMode: task.autoMode,
          executionOwner: task.executionOwner,
          assignees,
          blockedFromStatus: task.blockedFromStatus,
          skipReview: task.skipReview,
          runPostVerify: task.runPostVerify,
        },
        input.event,
        context,
      );
      if (!resolution.ok) {
        log.warn(
          {
            taskId: task.id,
            event: input.event,
            status: task.status,
            executionOwner: task.executionOwner,
            actorKind: input.actor.kind,
            actorId: input.actor.id,
            code: resolution.code,
          },
          "Task action rejected",
        );
        return {
          ok: false,
          code: resolution.code,
          message: resolution.error,
          currentStatus: task.status,
        } as const;
      }

      const updated = tx
        .update(tasks)
        .set({
          ...normalizeExtra(input.extra ?? {}),
          ...normalizeExtra(resolution.patch),
          status: resolution.patch.status,
          sessionId: null,
          ...(input.event === "retry_from_blocked"
            ? {}
            : {
                activeRuntimeStatus: null,
                activeRuntimeSelectionJson: null,
              }),
          lastHeartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
        .returning()
        .get();
      if (!updated) return statusConflict(task);

      appendTransitionAudit(tx, {
        task,
        assignees,
        fromStatus: task.status,
        toStatus: updated.status,
        actor: input.actor,
        action: `task.action.${input.event}`,
        reason: input.reason ?? null,
        createdAt: nowIso,
      });
      log.info(
        {
          taskId: task.id,
          event: input.event,
          fromStatus: task.status,
          toStatus: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
        },
        "Task action committed",
      );
      return {
        ok: true,
        task: updated,
        fromStatus: task.status,
        toStatus: updated.status,
      } as const;
    });
  } catch (error) {
    log.error(
      { error, taskId: input.taskId, event: input.event },
      "Task action transaction failed",
    );
    throw error;
  }
}
