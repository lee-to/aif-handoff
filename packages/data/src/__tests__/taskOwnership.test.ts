import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { participants, taskAssignments, tasks, type AuditActor } from "@aif/shared";
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
  claimTask,
  createParticipant,
  createTask,
  createTaskComment,
  deleteTask,
  findTaskById,
  handoffTaskExecution,
  listAuditEvents,
  listTaskComments,
  listTaskExecutorHistory,
  listTaskListItems,
  listTasks,
  listTasksPaginated,
  searchTasks,
  searchTasksPaginated,
  setTaskFields,
  transitionTaskStatus,
  toCommentResponse,
  toTaskResponse,
  toTaskSummary,
  updateParticipant,
  updateTask,
} = await import("../index.js");

const actor: AuditActor = {
  kind: "participant",
  id: "admin-1",
  displayNameSnapshot: "Admin",
};

beforeEach(() => {
  testDb.current = createTestDb();
});

async function createActiveParticipant(username: string, displayName: string) {
  const result = await createParticipant({
    username,
    displayName,
    password: "safe password",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Participant setup failed");
  return result.participant;
}

describe("task ownership hydration and filters", () => {
  it("hydrates owner and multi-assignee data across detail, list, summary, search, and comments", async () => {
    const alice = await createActiveParticipant("alice", "Alice");
    const bob = await createActiveParticipant("bob", "Bob");
    const task = createTask({
      projectId: "project-1",
      title: "Shared human task",
      description: "Coordinate the rollout",
      executionOwner: "human",
      assigneeIds: [bob.id, alice.id],
      actor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    const expectedAssignees = [
      { participantId: alice.id, displayName: "Alice", role: "member", active: true },
      { participantId: bob.id, displayName: "Bob", role: "member", active: true },
    ];
    expect(findTaskById(task.id)?.assignees).toEqual(expectedAssignees);
    expect(toTaskResponse(findTaskById(task.id)!)).toMatchObject({
      executionOwner: "human",
      ownershipRevision: 0,
      assignees: expectedAssignees,
    });
    expect(listTasks("project-1")[0]?.assignees).toEqual(expectedAssignees);
    expect(listTaskListItems("project-1")[0]?.assignees).toEqual(expectedAssignees);
    expect(searchTasks("Shared", "project-1")[0]?.assignees).toEqual(expectedAssignees);

    const paginated = listTasksPaginated({ projectId: "project-1" });
    expect(toTaskSummary(paginated.items[0]!)).toMatchObject({
      executionOwner: "human",
      ownershipRevision: 0,
      assignees: expectedAssignees,
    });
    const searched = searchTasksPaginated({ query: "rollout", projectId: "project-1" });
    expect(toTaskSummary(searched.items[0]!)).toMatchObject({
      assignees: expectedAssignees,
    });

    const comment = createTaskComment({
      taskId: task.id,
      author: "human",
      participantId: alice.id,
      message: "I will take the first pass",
    });
    expect(comment?.participant).toMatchObject({ id: alice.id, displayName: "Alice" });
    expect(toCommentResponse(comment!)).toMatchObject({
      participantId: alice.id,
      participant: { id: alice.id, displayName: "Alice" },
    });
    expect(listTaskComments(task.id)[0]?.participant).toMatchObject({
      id: alice.id,
      displayName: "Alice",
    });
  });

  it("filters AI, human, current-participant, explicit-assignee, and unassigned tasks", async () => {
    const alice = await createActiveParticipant("alice", "Alice");
    createTask({
      projectId: "project-1",
      title: "AI task",
      description: "",
    });
    const assigned = createTask({
      projectId: "project-1",
      title: "Assigned human task",
      description: "",
      executionOwner: "human",
      assigneeIds: [alice.id],
      actor,
    });
    const unassigned = createTask({
      projectId: "project-1",
      title: "Unassigned human task",
      description: "",
      executionOwner: "human",
      actor,
    });
    expect(assigned && unassigned).toBeTruthy();

    expect(
      listTasks("project-1", { executionOwner: "ai" }).map((task) => task.title),
    ).toEqual(["AI task"]);
    expect(
      listTasks("project-1", { executionOwner: "human" }).map((task) => task.title),
    ).toEqual(["Assigned human task", "Unassigned human task"]);
    expect(
      listTaskListItems("project-1", { currentParticipantId: alice.id }).map(
        (task) => task.id,
      ),
    ).toEqual([assigned?.id]);
    expect(
      searchTasks("task", "project-1", { assigneeId: alice.id }).map((task) => task.id),
    ).toEqual([assigned?.id]);
    expect(
      listTasksPaginated({
        projectId: "project-1",
        executionOwner: "human",
        unassigned: true,
      }).items.map((task) => task.id),
    ).toEqual([unassigned?.id]);
    expect(
      searchTasksPaginated({
        query: "human",
        projectId: "project-1",
        unassigned: true,
      }).items.map((task) => task.id),
    ).toEqual([unassigned?.id]);
  });
});

describe("atomic execution handoff", () => {
  it("supports AI to Human, Human reassignment, and Human to AI with ordered immutable history", async () => {
    const alice = await createActiveParticipant("alice", "Alice");
    const bob = await createActiveParticipant("bob", "Bob");
    const task = createTask({
      projectId: "project-1",
      title: "Handoff task",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;
    const createdAtMs = new Date(task.createdAt).getTime();

    const toHuman = handoffTaskExecution({
      taskId: task.id,
      executionOwner: "human",
      assigneeIds: [alice.id, bob.id],
      expectedOwnershipRevision: 0,
      expectedExecutionOwner: "ai",
      expectedStatus: "backlog",
      actor,
      reason: "Needs participant input",
      now: new Date(createdAtMs + 1_000),
    });
    expect(toHuman).toMatchObject({
      ok: true,
      ownership: {
        executionOwner: "human",
        ownershipRevision: 1,
        assignees: [
          { participantId: alice.id },
          { participantId: bob.id },
        ],
      },
    });

    const reassigned = handoffTaskExecution({
      taskId: task.id,
      executionOwner: "human",
      assigneeIds: [bob.id],
      expectedOwnershipRevision: 1,
      expectedExecutionOwner: "human",
      actor,
      now: new Date(createdAtMs + 2_000),
    });
    expect(reassigned).toMatchObject({
      ok: true,
      ownership: {
        executionOwner: "human",
        ownershipRevision: 2,
        assignees: [{ participantId: bob.id }],
      },
    });

    const toAi = handoffTaskExecution({
      taskId: task.id,
      executionOwner: "ai",
      expectedOwnershipRevision: 2,
      expectedExecutionOwner: "human",
      actor,
      now: new Date(createdAtMs + 3_000),
    });
    expect(toAi).toMatchObject({
      ok: true,
      ownership: {
        executionOwner: "ai",
        ownershipRevision: 3,
        assignees: [],
      },
    });
    expect(findTaskById(task.id)?.status).toBe("planning");
    expect(
      testDb.current
        .select()
        .from(taskAssignments)
        .where(eq(taskAssignments.taskId, task.id))
        .all(),
    ).toEqual([]);

    const history = listTaskExecutorHistory(task.id);
    expect(history.map((entry) => entry.ownershipRevision)).toEqual([0, 1, 2, 3]);
    expect(history.map((entry) => entry.executionOwner)).toEqual([
      "ai",
      "human",
      "human",
      "ai",
    ]);
    expect(history[1]?.reason).toBe("Needs participant input");
    expect(
      listAuditEvents({ taskId: task.id }).map((event) => event.action),
    ).toEqual([
      "task.created",
      "task.execution_handoff",
      "task.execution_handoff",
      "task.execution_handoff",
    ]);
  });

  it("returns structured conflicts for stale state, invalid assignees, live locks, no-ops, and terminal tasks", async () => {
    const active = await createActiveParticipant("active", "Active");
    const inactive = await createActiveParticipant("inactive", "Inactive");
    testDb.current
      .update(participants)
      .set({ active: false })
      .where(eq(participants.id, inactive.id))
      .run();
    const task = createTask({
      projectId: "project-1",
      title: "Conflict task",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      handoffTaskExecution({
        taskId: "missing",
        executionOwner: "human",
        expectedOwnershipRevision: 0,
        actor,
      }),
    ).toEqual({ ok: false, code: "not_found" });
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "human",
        assigneeIds: [inactive.id],
        expectedOwnershipRevision: 0,
        actor,
      }),
    ).toMatchObject({ ok: false, code: "inactive_assignee" });
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "human",
        assigneeIds: [active.id],
        expectedOwnershipRevision: 9,
        actor,
      }),
    ).toMatchObject({ ok: false, code: "revision_conflict" });
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "human",
        assigneeIds: [active.id],
        expectedOwnershipRevision: 0,
        expectedStatus: "planning",
        actor,
      }),
    ).toMatchObject({ ok: false, code: "revision_conflict" });

    setTaskFields(task.id, {
      lockedBy: "coordinator",
      lockedUntil: "2026-07-24T10:05:00.000Z",
    });
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "human",
        assigneeIds: [active.id],
        expectedOwnershipRevision: 0,
        actor,
        now: new Date("2026-07-24T10:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false, code: "locked" });
    setTaskFields(task.id, { lockedUntil: "2026-07-24T09:59:00.000Z" });
    const success = handoffTaskExecution({
      taskId: task.id,
      executionOwner: "human",
      assigneeIds: [active.id],
      expectedOwnershipRevision: 0,
      actor,
      now: new Date("2026-07-24T10:00:00.000Z"),
    });
    expect(success.ok).toBe(true);
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "human",
        assigneeIds: [active.id],
        expectedOwnershipRevision: 1,
        actor,
      }),
    ).toMatchObject({ ok: false, code: "invalid_transition" });

    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "verified",
        actor: { kind: "system", id: "test", displayNameSnapshot: "Test" },
      }).ok,
    ).toBe(true);
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "ai",
        expectedOwnershipRevision: 1,
        actor,
      }),
    ).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("requires explicit blocked retry normalization when handing a human task to AI", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Blocked human task",
      description: "",
      executionOwner: "human",
      actor,
    });
    expect(task).toBeDefined();
    if (!task) return;
    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        expectedStatus: "backlog",
        extra: { blockedFromStatus: "review", blockedReason: "External dependency" },
        actor: { kind: "system", id: "test", displayNameSnapshot: "Test" },
      }).ok,
    ).toBe(true);

    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "ai",
        expectedOwnershipRevision: 0,
        expectedStatus: "blocked_external",
        actor,
      }),
    ).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(
      handoffTaskExecution({
        taskId: task.id,
        executionOwner: "ai",
        expectedOwnershipRevision: 0,
        expectedStatus: "blocked_external",
        resumeAction: "retry_from_blocked",
        actor,
      }),
    ).toMatchObject({ ok: true });
    expect(findTaskById(task.id)).toMatchObject({
      executionOwner: "ai",
      status: "review",
      blockedFromStatus: null,
      blockedReason: null,
    });
  });

  it("makes claim-versus-handoff races deterministic at the owner and lock CAS boundary", async () => {
    const alice = await createActiveParticipant("alice", "Alice");
    const claimedFirst = createTask({
      projectId: "project-1",
      title: "Claim wins",
      description: "",
    });
    expect(claimedFirst).toBeDefined();
    if (!claimedFirst) return;
    expect(claimTask(claimedFirst.id, "coordinator", 60_000)).toBe(true);
    expect(
      handoffTaskExecution({
        taskId: claimedFirst.id,
        executionOwner: "human",
        assigneeIds: [alice.id],
        expectedOwnershipRevision: 0,
        actor,
      }),
    ).toMatchObject({ ok: false, code: "locked" });

    const handoffFirst = createTask({
      projectId: "project-1",
      title: "Handoff wins",
      description: "",
    });
    expect(handoffFirst).toBeDefined();
    if (!handoffFirst) return;
    expect(
      handoffTaskExecution({
        taskId: handoffFirst.id,
        executionOwner: "human",
        assigneeIds: [alice.id],
        expectedOwnershipRevision: 0,
        actor,
      }).ok,
    ).toBe(true);
    expect(claimTask(handoffFirst.id, "coordinator", 60_000)).toBe(false);
  });

  it("rejects a lock acquired after the handoff snapshot but before its update", async () => {
    const alice = await createActiveParticipant("alice", "Alice");
    const task = createTask({
      projectId: "project-1",
      title: "Late claim",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;

    const db = testDb.current as any;
    const transaction = db.transaction.bind(db);
    db.transaction = (callback: (tx: any) => unknown) =>
      transaction((tx: any) => {
        const update = tx.update.bind(tx);
        let injected = false;
        tx.update = (table: unknown) => {
          if (table === tasks && !injected) {
            injected = true;
            update(tasks)
              .set({
                lockedBy: "coordinator",
                lockedUntil: "2026-07-24T10:05:00.000Z",
              })
              .where(eq(tasks.id, task.id))
              .run();
          }
          return update(table);
        };
        return callback(tx);
      });

    try {
      expect(
        handoffTaskExecution({
          taskId: task.id,
          executionOwner: "human",
          assigneeIds: [alice.id],
          expectedOwnershipRevision: 0,
          actor,
          now: new Date("2026-07-24T10:00:00.000Z"),
        }),
      ).toMatchObject({ ok: false, code: "locked" });
      expect(findTaskById(task.id)).toMatchObject({
        executionOwner: "ai",
        ownershipRevision: 0,
        lockedBy: "coordinator",
      });
    } finally {
      db.transaction = transaction;
    }
  });

  it("keeps ownership out of generic updates and retains snapshots after rename and task deletion", async () => {
    const alice = await createActiveParticipant("alice", "Alice Original");
    const task = createTask({
      projectId: "project-1",
      title: "Snapshot title",
      description: "",
      executionOwner: "human",
      assigneeIds: [alice.id],
      actor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    Reflect.apply(updateTask, undefined, [
      task.id,
      { executionOwner: "ai", ownershipRevision: 99, assigneeIds: [] },
    ]);
    Reflect.apply(setTaskFields, undefined, [
      task.id,
      { status: "verified", executionOwner: "ai", ownershipRevision: 99 },
    ]);
    expect(findTaskById(task.id)).toMatchObject({
      executionOwner: "human",
      ownershipRevision: 0,
      status: "backlog",
      assignees: [{ participantId: alice.id }],
    });

    expect(
      updateParticipant(alice.id, { displayName: "Alice Renamed" }, actor).ok,
    ).toBe(true);
    deleteTask(task.id);
    expect(findTaskById(task.id)).toBeUndefined();
    expect(listTaskExecutorHistory(task.id)).toMatchObject([
      {
        taskTitleSnapshot: "Snapshot title",
        assignees: [{ displayName: "Alice Original" }],
      },
    ]);
    expect(listAuditEvents({ taskId: task.id })[0]).toMatchObject({
      taskTitleSnapshot: "Snapshot title",
      assigneesSnapshot: [{ displayName: "Alice Original" }],
    });
  });
});
