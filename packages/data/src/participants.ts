import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participantSessions,
  participants,
  taskAssignments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
  type CreateParticipantInput,
  type Participant,
  type TaskAssigneeSummary,
  type UpdateParticipantInput,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";
import {
  hashParticipantPassword,
  normalizeParticipantUsername,
  verifyParticipantPasswordOrDummy,
} from "./authSessions.js";

const log = logger("data:participants");
const SYSTEM_ACTOR: AuditActor = {
  kind: "system",
  id: null,
  displayNameSnapshot: "System",
};

export type ParticipantRepositoryErrorCode =
  | "not_found"
  | "duplicate_username"
  | "final_active_admin"
  | "inactive_participant"
  | "invalid_current_password"
  | "invalid_input";

export type ParticipantMutationResult =
  | {
      ok: true;
      participant: Participant;
      revokedSessionCount?: number;
      affectedTaskIds?: string[];
    }
  | { ok: false; code: ParticipantRepositoryErrorCode };

function isSqliteUniqueConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

function toParticipant(row: typeof participants.$inferSelect): Participant {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function countActiveAdmins(
  database: ReturnType<typeof getDb>,
): number {
  const result = database
    .select({ value: count() })
    .from(participants)
    .where(and(eq(participants.active, true), eq(participants.role, "admin")))
    .get();
  return result?.value ?? 0;
}

function listAssignmentSnapshots(
  database: ReturnType<typeof getDb>,
  taskId: string,
): TaskAssigneeSummary[] {
  return database
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

export function countParticipants(): number {
  const result = getDb().select({ value: count() }).from(participants).get();
  return result?.value ?? 0;
}

export function listParticipants(options: { includeInactive?: boolean } = {}): Participant[] {
  const rows = options.includeInactive
    ? getDb().select().from(participants).orderBy(asc(participants.displayName), asc(participants.id)).all()
    : getDb()
        .select()
        .from(participants)
        .where(eq(participants.active, true))
        .orderBy(asc(participants.displayName), asc(participants.id))
        .all();
  log.debug(
    { includeInactive: options.includeInactive ?? false, count: rows.length },
    "Listed participants",
  );
  return rows.map(toParticipant);
}

export function findParticipantById(participantId: string): Participant | null {
  const row = getDb()
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  log.debug({ participantId, found: Boolean(row) }, "Looked up participant by ID");
  return row ? toParticipant(row) : null;
}

export function findParticipantByUsername(username: string): Participant | null {
  const row = getDb()
    .select()
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizeParticipantUsername(username)))
    .get();
  log.debug({ participantId: row?.id ?? null, found: Boolean(row) }, "Looked up participant");
  return row ? toParticipant(row) : null;
}

export async function createParticipant(
  input: CreateParticipantInput,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  const username = input.username.trim();
  const normalizedUsername = normalizeParticipantUsername(username);
  const displayName = input.displayName.trim();
  const role = input.role ?? "member";
  log.debug({ role, actorKind: actor.kind, actorId: actor.id }, "Creating participant");

  if (!username || !normalizedUsername || !displayName || !input.password) {
    log.warn({ role, actorKind: actor.kind }, "Rejected invalid participant creation input");
    return { ok: false, code: "invalid_input" };
  }

  const existing = getDb()
    .select({ id: participants.id })
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizedUsername))
    .get();
  if (existing) {
    log.warn({ participantId: existing.id }, "Rejected duplicate participant username");
    return { ok: false, code: "duplicate_username" };
  }

  const passwordHash = await hashParticipantPassword(input.password);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  try {
    const created = getDb().transaction((tx) => {
      const row = tx
        .insert(participants)
        .values({
          id,
          username,
          normalizedUsername,
          displayName,
          passwordHash,
          role,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.created",
            entityType: "participant",
            entityId: row.id,
            participantId: row.id,
            participantDisplayNameSnapshot: row.displayName,
            actor,
            metadata: { role: row.role },
            createdAt: now,
          }),
        )
        .run();
      return row;
    });
    log.info({ participantId: created.id, role: created.role }, "Participant created");
    return { ok: true, participant: toParticipant(created) };
  } catch (error) {
    if (isSqliteUniqueConstraint(error)) {
      log.warn({ participantId: id }, "Participant creation lost duplicate username race");
      return { ok: false, code: "duplicate_username" };
    }
    log.error({ error, participantId: id, role }, "Participant creation failed");
    throw error;
  }
}

export function updateParticipant(
  participantId: string,
  input: UpdateParticipantInput,
  actor: AuditActor = SYSTEM_ACTOR,
): ParticipantMutationResult {
  const db = getDb();
  const displayName = input.displayName?.trim();
  log.debug(
    {
      participantId,
      hasDisplayName: input.displayName !== undefined,
      requestedRole: input.role ?? null,
      actorKind: actor.kind,
      actorId: actor.id,
    },
    "Updating participant",
  );

  if (input.displayName !== undefined && !displayName) {
    log.warn({ participantId }, "Rejected empty participant display name");
    return { ok: false, code: "invalid_input" };
  }

  try {
    return db.transaction((tx) => {
      const current = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!current) return { ok: false, code: "not_found" } as const;
      if (!current.active) return { ok: false, code: "inactive_participant" } as const;

      const isDemotingActiveAdmin =
        current.role === "admin" && input.role === "member";
      if (isDemotingActiveAdmin && countActiveAdmins(tx) <= 1) {
        log.warn({ participantId }, "Rejected final active admin demotion");
        return { ok: false, code: "final_active_admin" } as const;
      }

      const now = new Date().toISOString();
      const roleChanged = input.role !== undefined && input.role !== current.role;
      const revokedSessions = roleChanged
        ? tx
            .update(participantSessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(participantSessions.participantId, participantId),
                isNull(participantSessions.revokedAt),
              ),
            )
            .run()
        : null;
      const updated = tx
        .update(participants)
        .set({
          displayName: displayName ?? current.displayName,
          role: input.role ?? current.role,
          updatedAt: now,
        })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.updated",
            entityType: "participant",
            entityId: updated.id,
            participantId: updated.id,
            participantDisplayNameSnapshot: updated.displayName,
            actor,
            metadata: {
              previousRole: current.role,
              role: updated.role,
              displayNameChanged: updated.displayName !== current.displayName,
              revokedSessionCount: revokedSessions?.changes ?? 0,
            },
            createdAt: now,
          }),
        )
        .run();
      log.info(
        {
          participantId,
          role: updated.role,
          revokedSessionCount: revokedSessions?.changes ?? 0,
        },
        "Participant updated",
      );
      return {
        ok: true,
        participant: toParticipant(updated),
        revokedSessionCount: revokedSessions?.changes,
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant update failed");
    throw error;
  }
}

export function deactivateParticipant(
  participantId: string,
  actor: AuditActor = SYSTEM_ACTOR,
): ParticipantMutationResult {
  const db = getDb();
  const now = new Date().toISOString();
  log.debug(
    { participantId, actorKind: actor.kind, actorId: actor.id },
    "Deactivating participant",
  );

  try {
    return db.transaction((tx) => {
      const participant = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!participant) return { ok: false, code: "not_found" } as const;
      if (!participant.active) return { ok: false, code: "inactive_participant" } as const;
      if (participant.role === "admin" && countActiveAdmins(tx) <= 1) {
        log.warn({ participantId }, "Rejected final active admin deactivation");
        return { ok: false, code: "final_active_admin" } as const;
      }

      const affectedTasks = tx
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          executionOwner: tasks.executionOwner,
          ownershipRevision: tasks.ownershipRevision,
        })
        .from(taskAssignments)
        .innerJoin(tasks, eq(taskAssignments.taskId, tasks.id))
        .where(eq(taskAssignments.participantId, participantId))
        .all();
      tx.delete(taskAssignments)
        .where(eq(taskAssignments.participantId, participantId))
        .run();

      for (const task of affectedTasks) {
        const revisionRow = tx
          .update(tasks)
          .set({
            ownershipRevision: sql`${tasks.ownershipRevision} + 1`,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id))
          .returning({ ownershipRevision: tasks.ownershipRevision })
          .get();
        const assignees = listAssignmentSnapshots(tx, task.id);
        const ownershipRevision = revisionRow?.ownershipRevision ?? task.ownershipRevision + 1;
        tx.insert(taskExecutorHistory)
          .values({
            id: crypto.randomUUID(),
            taskId: task.id,
            taskTitleSnapshot: task.title,
            ownershipRevision,
            executionOwner: task.executionOwner,
            assigneesSnapshotJson: JSON.stringify(assignees),
            statusSnapshot: task.status,
            actorKind: actor.kind,
            actorId: actor.id,
            actorDisplayNameSnapshot: actor.displayNameSnapshot,
            reason: "participant_deactivated",
            createdAt: now,
          })
          .run();
        tx.insert(auditEvents)
          .values(
            createAuditEventValues({
              action: "task.assignment_removed",
              entityType: "task",
              entityId: task.id,
              taskId: task.id,
              taskTitleSnapshot: task.title,
              participantId,
              participantDisplayNameSnapshot: participant.displayName,
              executionOwnerSnapshot: task.executionOwner,
              assigneesSnapshot: assignees,
              statusSnapshot: task.status,
              actor,
              reason: "participant_deactivated",
              metadata: { ownershipRevision },
              createdAt: now,
            }),
          )
          .run();
      }

      const revokedSessions = tx
        .update(participantSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(participantSessions.participantId, participantId),
            isNull(participantSessions.revokedAt),
          ),
        )
        .run();
      const deactivated = tx
        .update(participants)
        .set({ active: false, deactivatedAt: now, updatedAt: now })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.deactivated",
            entityType: "participant",
            entityId: participantId,
            participantId,
            participantDisplayNameSnapshot: participant.displayName,
            actor,
            metadata: {
              revokedSessionCount: revokedSessions.changes,
              removedAssignmentCount: affectedTasks.length,
            },
            createdAt: now,
          }),
        )
        .run();

      log.info(
        {
          participantId,
          revokedSessionCount: revokedSessions.changes,
          removedAssignmentCount: affectedTasks.length,
        },
        "Participant deactivated",
      );
      return {
        ok: true,
        participant: toParticipant(deactivated),
        revokedSessionCount: revokedSessions.changes,
        affectedTaskIds: affectedTasks.map((task) => task.id),
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant deactivation failed");
    throw error;
  }
}

export async function resetParticipantPassword(
  participantId: string,
  password: string,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  if (!password) {
    log.warn({ participantId }, "Rejected empty participant password reset");
    return { ok: false, code: "invalid_input" };
  }
  log.debug(
    { participantId, actorKind: actor.kind, actorId: actor.id },
    "Resetting participant password",
  );
  const passwordHash = await hashParticipantPassword(password);
  const now = new Date().toISOString();

  try {
    return getDb().transaction((tx) => {
      const participant = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!participant) return { ok: false, code: "not_found" } as const;
      if (!participant.active) return { ok: false, code: "inactive_participant" } as const;

      const updated = tx
        .update(participants)
        .set({ passwordHash, updatedAt: now })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      const revokedSessions = tx
        .update(participantSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(participantSessions.participantId, participantId),
            isNull(participantSessions.revokedAt),
          ),
        )
        .run();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.password_reset",
            entityType: "participant",
            entityId: participantId,
            participantId,
            participantDisplayNameSnapshot: participant.displayName,
            actor,
            metadata: { revokedSessionCount: revokedSessions.changes },
            createdAt: now,
          }),
        )
        .run();
      log.info(
        { participantId, revokedSessionCount: revokedSessions.changes },
        "Participant password reset",
      );
      return {
        ok: true,
        participant: toParticipant(updated),
        revokedSessionCount: revokedSessions.changes,
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant password reset failed");
    throw error;
  }
}

export async function changeParticipantPassword(
  participantId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionId: string,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  if (!currentPassword || !newPassword || currentPassword === newPassword || !currentSessionId) {
    log.warn({ participantId }, "Rejected invalid participant password change input");
    return { ok: false, code: "invalid_input" };
  }

  const participant = getDb()
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  const verified = await verifyParticipantPasswordOrDummy(
    currentPassword,
    participant?.passwordHash ?? null,
  );
  if (!participant) return { ok: false, code: "not_found" };
  if (!participant.active) return { ok: false, code: "inactive_participant" };
  if (!verified) {
    log.warn({ participantId }, "Rejected invalid current participant password");
    return { ok: false, code: "invalid_current_password" };
  }

  const passwordHash = await hashParticipantPassword(newPassword);
  const now = new Date().toISOString();
  return getDb().transaction((tx) => {
    const updated = tx
      .update(participants)
      .set({ passwordHash, updatedAt: now })
      .where(
        and(
          eq(participants.id, participantId),
          eq(participants.active, true),
          eq(participants.passwordHash, participant.passwordHash),
        ),
      )
      .returning()
      .get();
    if (!updated) {
      const current = tx
        .select({ active: participants.active })
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!current) return { ok: false, code: "not_found" } as const;
      if (!current.active) return { ok: false, code: "inactive_participant" } as const;
      return { ok: false, code: "invalid_current_password" } as const;
    }

    const revokedSessions = tx
      .update(participantSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(participantSessions.participantId, participantId),
          ne(participantSessions.id, currentSessionId),
          isNull(participantSessions.revokedAt),
        ),
      )
      .run();
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "participant.password_changed",
          entityType: "participant",
          entityId: participantId,
          participantId,
          participantDisplayNameSnapshot: participant.displayName,
          actor,
          metadata: { revokedSessionCount: revokedSessions.changes },
          createdAt: now,
        }),
      )
      .run();
    log.info(
      { participantId, revokedSessionCount: revokedSessions.changes },
      "Participant password changed",
    );
    return {
      ok: true,
      participant: toParticipant(updated),
      revokedSessionCount: revokedSessions.changes,
    } as const;
  });
}
