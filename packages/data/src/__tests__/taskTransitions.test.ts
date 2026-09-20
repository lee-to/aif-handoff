import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { projects } from "@aif/shared";
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
  applyTaskAction,
  createParticipant,
  createTask,
  findTaskById,
  listAuditEvents,
  transitionTaskStatus,
} = await import("../index.js");

const adminActor = {
  kind: "participant" as const,
  id: "admin-1",
  displayNameSnapshot: "Admin",
};

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project-1", name: "Project", rootPath: "/tmp/project" })
    .run();
});

describe("atomic task transitions", () => {
  it("commits an assigned participant action and audit record together", async () => {
    const participant = await createParticipant(
      {
        username: "member",
        displayName: "Member",
        password: "password-123",
        role: "member",
      },
      adminActor,
    );
    expect(participant.ok).toBe(true);
    if (!participant.ok) return;
    const task = createTask({
      projectId: "project-1",
      title: "Human task",
      description: "",
      executionOwner: "human",
      assigneeIds: [participant.participant.id],
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    const result = applyTaskAction({
      taskId: task.id,
      event: "start_human_work",
      participantsModeEnabled: true,
      actor: {
        kind: "participant",
        id: participant.participant.id,
        displayNameSnapshot: participant.participant.displayName,
      },
      participantRole: "member",
      participantActive: true,
      expectedStatus: "backlog",
    });

    expect(result).toMatchObject({
      ok: true,
      fromStatus: "backlog",
      toStatus: "planning",
    });
    expect(findTaskById(task.id)?.status).toBe("planning");
    expect(listAuditEvents({ taskId: task.id }).at(-1)).toMatchObject({
      action: "task.action.start_human_work",
      statusSnapshot: "planning",
      actor: { kind: "participant", id: participant.participant.id },
      metadata: { fromStatus: "backlog", toStatus: "planning" },
    });
  });

  it("denies unassigned members and reports stale status without mutating", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Unassigned",
      description: "",
      executionOwner: "human",
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      applyTaskAction({
        taskId: task.id,
        event: "start_human_work",
        participantsModeEnabled: true,
        actor: {
          kind: "participant",
          id: "member-1",
          displayNameSnapshot: "Member",
        },
        participantRole: "member",
      }),
    ).toMatchObject({ ok: false, code: "assignment_required" });
    expect(
      applyTaskAction({
        taskId: task.id,
        event: "start_human_work",
        participantsModeEnabled: true,
        actor: adminActor,
        participantRole: "admin",
        expectedStatus: "planning",
      }),
    ).toMatchObject({
      ok: false,
      code: "status_conflict",
      currentStatus: "backlog",
    });
    expect(findTaskById(task.id)?.status).toBe("backlog");
    expect(listAuditEvents({ taskId: task.id })).toHaveLength(1);
  });

  it("rejects agents on human-owned tasks and permits system recovery", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Human recovery",
      description: "",
      executionOwner: "human",
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        actor: { kind: "agent", id: "coordinator", displayNameSnapshot: "Coordinator" },
      }),
    ).toMatchObject({ ok: false, code: "ai_handoff_required" });
    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        expectedStatus: "backlog",
        actor: { kind: "system", id: "watchdog", displayNameSnapshot: "Watchdog" },
      }),
    ).toMatchObject({ ok: true, toStatus: "blocked_external" });
  });

  it("rolls back the status mutation when audit persistence fails", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Rollback",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;
    testDb.current.run(sql`
      CREATE TRIGGER fail_status_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'task.status_changed'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END
    `);

    expect(() =>
      transitionTaskStatus({
        taskId: task.id,
        status: "planning",
        expectedStatus: "backlog",
        actor: { kind: "system", id: "test", displayNameSnapshot: "Test" },
      }),
    ).toThrow("forced audit failure");
    expect(findTaskById(task.id)?.status).toBe("backlog");
    expect(listAuditEvents({ taskId: task.id })).toHaveLength(1);
  });
});
