import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  participantSessions,
  participants,
  taskAssignments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  appendAuditEvent,
  authenticateParticipant,
  changeParticipantPassword,
  createParticipant,
  createParticipantSession,
  deactivateParticipant,
  findParticipantById,
  findParticipantByUsername,
  listAuditEvents,
  listParticipants,
  resetParticipantPassword,
  resolveParticipantSession,
  updateParticipant,
} = await import("../index.js");

const adminActor: AuditActor = {
  kind: "participant",
  id: "admin-actor",
  displayNameSnapshot: "Admin",
};

beforeEach(() => {
  testDb.current = createTestDb();
});

describe("participant administration", () => {
  it("creates, normalizes, lists, and rejects duplicate usernames", async () => {
    const created = await createParticipant({
      username: "  Alice  ",
      displayName: "Alice Example",
      password: "safe password",
      role: "admin",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(findParticipantById(created.participant.id)).toEqual(created.participant);
    expect(findParticipantByUsername("ALICE")).toEqual(created.participant);
    expect(listParticipants()).toEqual([created.participant]);

    await expect(
      createParticipant({
        username: "ＡＬＩＣＥ",
        displayName: "Duplicate",
        password: "other password",
      }),
    ).resolves.toEqual({ ok: false, code: "duplicate_username" });
  });

  it("protects the final active admin from demotion and deactivation", async () => {
    const first = await createParticipant({
      username: "admin-one",
      displayName: "Admin One",
      password: "safe password",
      role: "admin",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(updateParticipant(first.participant.id, { role: "member" }, adminActor)).toEqual({
      ok: false,
      code: "final_active_admin",
    });
    expect(deactivateParticipant(first.participant.id, adminActor)).toEqual({
      ok: false,
      code: "final_active_admin",
    });

    const second = await createParticipant({
      username: "admin-two",
      displayName: "Admin Two",
      password: "safe password",
      role: "admin",
    });
    expect(second.ok).toBe(true);
    const session = createParticipantSession(first.participant.id, { ttlMs: 60_000 });
    expect(session).not.toBeNull();
    expect(updateParticipant(first.participant.id, { role: "member" }, adminActor)).toMatchObject({
      ok: true,
      participant: { role: "member" },
      revokedSessionCount: 1,
    });
    if (session) expect(resolveParticipantSession(session.token)).toBeNull();
  });

  it("resets passwords and revokes every active session", async () => {
    const created = await createParticipant({
      username: "reset-user",
      displayName: "Reset User",
      password: "old password",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const session = createParticipantSession(created.participant.id, { ttlMs: 60_000 });
    expect(session).not.toBeNull();
    if (!session) return;

    const result = await resetParticipantPassword(
      created.participant.id,
      "new password",
      adminActor,
    );
    expect(result).toMatchObject({ ok: true, revokedSessionCount: 1 });
    expect(resolveParticipantSession(session.token)).toBeNull();
    await expect(
      authenticateParticipant("reset-user", "old password", { sessionTtlMs: 60_000 }),
    ).resolves.toEqual({ ok: false, code: "invalid_credentials" });
    const authenticated = await authenticateParticipant("reset-user", "new password", {
      sessionTtlMs: 60_000,
    });
    expect(authenticated.ok).toBe(true);
  });

  it("changes a participant password while preserving only the current session", async () => {
    const created = await createParticipant({
      username: "change-password-user",
      displayName: "Change Password User",
      password: "old secure password",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const currentSession = createParticipantSession(created.participant.id, { ttlMs: 60_000 });
    const otherSession = createParticipantSession(created.participant.id, { ttlMs: 60_000 });
    expect(currentSession).not.toBeNull();
    expect(otherSession).not.toBeNull();
    if (!currentSession || !otherSession) return;

    await expect(
      changeParticipantPassword(
        created.participant.id,
        "wrong current password",
        "new secure password",
        currentSession.id,
        {
          kind: "participant",
          id: created.participant.id,
          displayNameSnapshot: created.participant.displayName,
        },
      ),
    ).resolves.toEqual({ ok: false, code: "invalid_current_password" });
    expect(resolveParticipantSession(currentSession.token)).not.toBeNull();

    const result = await changeParticipantPassword(
      created.participant.id,
      "old secure password",
      "new secure password",
      currentSession.id,
      {
        kind: "participant",
        id: created.participant.id,
        displayNameSnapshot: created.participant.displayName,
      },
    );
    expect(result).toMatchObject({ ok: true, revokedSessionCount: 1 });
    expect(resolveParticipantSession(currentSession.token)).not.toBeNull();
    expect(resolveParticipantSession(otherSession.token)).toBeNull();
    await expect(
      authenticateParticipant("change-password-user", "old secure password", {
        sessionTtlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid_credentials" });
    await expect(
      authenticateParticipant("change-password-user", "new secure password", {
        sessionTtlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      listAuditEvents({ participantId: created.participant.id }).map((event) => event.action),
    ).toContain("participant.password_changed");
  });

  it("deactivates accounts, revokes sessions, removes assignments, and preserves history snapshots", async () => {
    const admin = await createParticipant({
      username: "admin",
      displayName: "Admin",
      password: "safe password",
      role: "admin",
    });
    const member = await createParticipant({
      username: "member",
      displayName: "Member Before Deactivation",
      password: "safe password",
    });
    expect(admin.ok).toBe(true);
    expect(member.ok).toBe(true);
    if (!admin.ok || !member.ok) return;

    const session = createParticipantSession(member.participant.id, { ttlMs: 60_000 });
    expect(session).not.toBeNull();
    testDb.current
      .insert(tasks)
      .values({
        id: "human-task",
        projectId: "project-1",
        title: "Human-owned task",
        status: "implementing",
        executionOwner: "human",
      })
      .run();
    testDb.current
      .insert(taskAssignments)
      .values({
        taskId: "human-task",
        participantId: member.participant.id,
        assignedByKind: "participant",
        assignedById: admin.participant.id,
        assignedByDisplayNameSnapshot: admin.participant.displayName,
      })
      .run();

    const actor = {
      kind: "participant",
      id: admin.participant.id,
      displayNameSnapshot: admin.participant.displayName,
    } satisfies AuditActor;
    const result = deactivateParticipant(member.participant.id, actor);
    expect(result).toMatchObject({
      ok: true,
      participant: {
        active: false,
        displayName: "Member Before Deactivation",
      },
      revokedSessionCount: 1,
      affectedTaskIds: ["human-task"],
    });
    if (session) expect(resolveParticipantSession(session.token)).toBeNull();

    const assignment = testDb.current
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.participantId, member.participant.id))
      .get();
    const task = testDb.current.select().from(tasks).where(eq(tasks.id, "human-task")).get();
    const history = testDb.current
      .select()
      .from(taskExecutorHistory)
      .where(eq(taskExecutorHistory.taskId, "human-task"))
      .get();
    const storedParticipant = testDb.current
      .select()
      .from(participants)
      .where(eq(participants.id, member.participant.id))
      .get();
    const storedSession = testDb.current
      .select()
      .from(participantSessions)
      .where(eq(participantSessions.participantId, member.participant.id))
      .get();

    expect(assignment).toBeUndefined();
    expect(task?.ownershipRevision).toBe(1);
    expect(history).toMatchObject({
      taskTitleSnapshot: "Human-owned task",
      ownershipRevision: 1,
      executionOwner: "human",
      assigneesSnapshotJson: "[]",
      statusSnapshot: "implementing",
      actorId: admin.participant.id,
      reason: "participant_deactivated",
    });
    expect(storedParticipant?.active).toBe(false);
    expect(storedSession?.revokedAt).not.toBeNull();

    const events = listAuditEvents({ participantId: member.participant.id });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "participant.created",
        "task.assignment_removed",
        "participant.deactivated",
      ]),
    );
    expect(
      events.find((event) => event.action === "task.assignment_removed"),
    ).toMatchObject({
      participantDisplayNameSnapshot: "Member Before Deactivation",
      taskTitleSnapshot: "Human-owned task",
    });
    expect(
      await authenticateParticipant("member", "safe password", { sessionTtlMs: 60_000 }),
    ).toEqual({ ok: false, code: "invalid_credentials" });
  });

  it("returns structured missing and inactive conflicts", async () => {
    expect(updateParticipant("missing", { displayName: "Missing" }, adminActor)).toEqual({
      ok: false,
      code: "not_found",
    });
    await expect(resetParticipantPassword("missing", "password", adminActor)).resolves.toEqual({
      ok: false,
      code: "not_found",
    });

    const admin = await createParticipant({
      username: "admin",
      displayName: "Admin",
      password: "password",
      role: "admin",
    });
    const member = await createParticipant({
      username: "member",
      displayName: "Member",
      password: "password",
    });
    expect(admin.ok && member.ok).toBe(true);
    if (!member.ok) return;
    expect(deactivateParticipant(member.participant.id, adminActor).ok).toBe(true);
    expect(updateParticipant(member.participant.id, { displayName: "New" }, adminActor)).toEqual({
      ok: false,
      code: "inactive_participant",
    });
    await expect(
      resetParticipantPassword(member.participant.id, "new password", adminActor),
    ).resolves.toEqual({ ok: false, code: "inactive_participant" });
  });
});

describe("audit repository", () => {
  it("appends and filters immutable audit events without returning raw storage fields", () => {
    const created = appendAuditEvent({
      action: "task.tested",
      entityType: "task",
      entityId: "task-1",
      taskId: "task-1",
      taskTitleSnapshot: "Snapshot",
      actor: adminActor,
      metadata: { count: 2 },
    });

    expect(created).toMatchObject({
      action: "task.tested",
      taskId: "task-1",
      actor: adminActor,
      metadata: { count: 2 },
    });
    expect(listAuditEvents({ taskId: "task-1" })).toEqual([created]);
    expect(listAuditEvents({ taskId: "other" })).toEqual([]);
  });
});
