import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { projects, taskAssignments, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const PARTICIPANT_COOKIE = "test_participant_session";
const ORIGIN = "http://localhost:5180";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  const defaults = actual.validateEnv({});
  return {
    ...actual,
    getEnv: () => ({
      ...defaults,
      PARTICIPANTS_MODE_ENABLED: true,
      PARTICIPANT_SESSION_COOKIE_NAME: PARTICIPANT_COOKIE,
      PARTICIPANT_ALLOWED_ORIGINS: [ORIGIN],
      INTERNAL_BROADCAST_TOKEN: "internal-secret",
    }),
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../ws.js", () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const {
  createParticipant,
  createParticipantSession,
  createTask,
  findTaskById,
  getTaskOwnership,
  listTaskExecutorHistory,
} = await import("@aif/data");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { tasksRouter } = await import("../routes/tasks.js");

function createApp() {
  const app = new Hono<ParticipantApiEnv>();
  app.use("*", participantAuth);
  app.use("*", participantRouteAuthorization());
  app.use("*", participantCsrf());
  app.route("/tasks", tasksRouter);
  return app;
}

async function createAuthenticatedParticipant(role: "admin" | "member") {
  const id = crypto.randomUUID();
  const result = await createParticipant({
    username: `${role}-${id}`,
    displayName: role === "admin" ? "Collaboration Admin" : `Member ${id}`,
    password: "a sufficiently safe password",
    role,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("participant creation failed");
  const session = createParticipantSession(result.participant.id, { ttlMs: 60_000 });
  expect(session).not.toBeNull();
  if (!session) throw new Error("session creation failed");
  return { participant: result.participant, session };
}

function authHeaders(session: { token: string; csrfToken: string }, json = false) {
  return {
    cookie: `${PARTICIPANT_COOKIE}=${session.token}`,
    origin: ORIGIN,
    "x-csrf-token": session.csrfToken,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Collaboration Project",
      rootPath: "/tmp/collaboration-project",
    })
    .run();
  mockBroadcast.mockReset();
});

describe("task collaboration API", () => {
  it("creates human tasks with authenticated ownership history and member-safe assignments", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const app = createApp();
    const response = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        projectId: PROJECT_ID,
        title: "Human work",
        description: "Collaborate",
        executionOwner: "human",
        assigneeIds: [member.participant.id],
      }),
    });

    expect(response.status).toBe(201);
    const task = await response.json();
    expect(task).toMatchObject({
      executionOwner: "human",
      ownershipRevision: 0,
      assignees: [
        {
          participantId: member.participant.id,
          displayName: member.participant.displayName,
        },
      ],
      permissions: {
        canAssign: true,
        canHandoff: true,
      },
    });
    const history = listTaskExecutorHistory(task.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      executionOwner: "human",
      actor: {
        kind: "participant",
        id: admin.participant.id,
      },
      reason: "task_created",
    });
    expect(mockBroadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent:wake" }));
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "task:created",
      payload: expect.objectContaining({
        id: task.id,
        executionOwner: "human",
        actor: expect.objectContaining({ id: admin.participant.id }),
      }),
    });

    const forbidden = await app.request("/tasks", {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({
        projectId: PROJECT_ID,
        title: "Assign another",
        description: "",
        executionOwner: "human",
        assigneeIds: [admin.participant.id],
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "forbidden" });
  });

  it("filters by owner, assignee, current participant, and unassigned state", async () => {
    const member = await createAuthenticatedParticipant("member");
    createTask({
      projectId: PROJECT_ID,
      title: "AI task",
      description: "",
      executionOwner: "ai",
    });
    createTask({
      projectId: PROJECT_ID,
      title: "Assigned human",
      description: "",
      executionOwner: "human",
      assigneeIds: [member.participant.id],
    });
    createTask({
      projectId: PROJECT_ID,
      title: "Unassigned human",
      description: "",
      executionOwner: "human",
    });
    const app = createApp();
    const cookie = { cookie: `${PARTICIPANT_COOKIE}=${member.session.token}` };

    const assigned = await app.request(`/tasks?projectId=${PROJECT_ID}&owner=human&assigneeId=me`, {
      headers: cookie,
    });
    expect((await assigned.json()).map((task: { title: string }) => task.title)).toEqual([
      "Assigned human",
    ]);

    const unassigned = await app.request(
      `/tasks?projectId=${PROJECT_ID}&owner=human&unassigned=true`,
      { headers: cookie },
    );
    expect((await unassigned.json()).map((task: { title: string }) => task.title)).toEqual([
      "Unassigned human",
    ]);

    const invalid = await app.request(
      `/tasks?projectId=${PROJECT_ID}&assigneeId=me&unassigned=true`,
      { headers: cookie },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_task_filter" });
  });

  it("applies revision-checked admin handoffs and lets an assigned member return work to AI", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const created = createTask({
      projectId: PROJECT_ID,
      title: "Handoff task",
      description: "",
      executionOwner: "ai",
    });
    expect(created).toBeDefined();
    if (!created) return;
    const app = createApp();

    const toHuman = await app.request(`/tasks/${created.id}/handoff`, {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        executionOwner: "human",
        assigneeIds: [member.participant.id],
        expectedOwnershipRevision: 0,
        expectedExecutionOwner: "ai",
        reason: "Human expertise needed",
      }),
    });
    expect(toHuman.status).toBe(200);
    expect(await toHuman.json()).toMatchObject({
      ownership: {
        executionOwner: "human",
        ownershipRevision: 1,
        assignees: [{ participantId: member.participant.id }],
      },
      history: {
        actor: { id: admin.participant.id },
        reason: "Human expertise needed",
      },
    });

    const stale = await app.request(`/tasks/${created.id}/handoff`, {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        executionOwner: "ai",
        assigneeIds: [],
        expectedOwnershipRevision: 0,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "ownership_revision_conflict",
      ownership: { ownershipRevision: 1 },
    });

    mockBroadcast.mockClear();
    const toAi = await app.request(`/tasks/${created.id}/handoff`, {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({
        executionOwner: "ai",
        assigneeIds: [],
        expectedOwnershipRevision: 1,
        expectedExecutionOwner: "human",
      }),
    });
    expect(toAi.status).toBe(200);
    expect(await toAi.json()).toMatchObject({
      task: { status: "planning", executionOwner: "ai" },
      ownership: { ownershipRevision: 2, executionOwner: "ai", assignees: [] },
    });
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "task:handoff",
      payload: expect.objectContaining({
        taskId: created.id,
        actor: expect.objectContaining({ id: member.participant.id }),
        responsibleParticipants: [],
      }),
    });
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "agent:wake",
      payload: { id: created.id },
    });
  });

  it("supports self-assignment but rejects members assigning or taking AI work", async () => {
    const member = await createAuthenticatedParticipant("member");
    const humanTask = createTask({
      projectId: PROJECT_ID,
      title: "Unassigned",
      description: "",
      executionOwner: "human",
    });
    const aiTask = createTask({
      projectId: PROJECT_ID,
      title: "AI owned",
      description: "",
      executionOwner: "ai",
    });
    expect(humanTask && aiTask).toBeTruthy();
    if (!humanTask || !aiTask) return;
    const app = createApp();

    const selfAssign = await app.request(`/tasks/${humanTask.id}/handoff`, {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({
        executionOwner: "human",
        assigneeIds: [member.participant.id],
        expectedOwnershipRevision: 0,
      }),
    });
    expect(selfAssign.status).toBe(200);
    expect(getTaskOwnership(humanTask.id)).toMatchObject({
      ownershipRevision: 1,
      assignees: [{ participantId: member.participant.id }],
    });

    const forbidden = await app.request(`/tasks/${aiTask.id}/handoff`, {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({
        executionOwner: "human",
        assigneeIds: [member.participant.id],
        expectedOwnershipRevision: 0,
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "forbidden" });
  });

  it("rejects member mutations of tasks they are not assigned to", async () => {
    const member = await createAuthenticatedParticipant("member");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "Another participant's task",
      description: "",
      executionOwner: "ai",
    });
    expect(task).toBeDefined();
    if (!task) return;
    const app = createApp();

    const requests = [
      app.request(`/tasks/${task.id}`, {
        method: "PUT",
        headers: authHeaders(member.session, true),
        body: JSON.stringify({ paused: true }),
      }),
      app.request(`/tasks/${task.id}/position`, {
        method: "PATCH",
        headers: authHeaders(member.session, true),
        body: JSON.stringify({ position: 2_000 }),
      }),
      app.request(`/tasks/${task.id}/sync-plan`, {
        method: "POST",
        headers: authHeaders(member.session),
      }),
      app.request(`/tasks/${task.id}/run-qa`, {
        method: "POST",
        headers: authHeaders(member.session),
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }
    expect(findTaskById(task.id)).toMatchObject({ paused: false, position: task.position });
  });

  it("allows task mutations by administrators and active assignees", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const aiTask = createTask({
      projectId: PROJECT_ID,
      title: "Admin task",
      description: "",
      executionOwner: "ai",
    });
    const humanTask = createTask({
      projectId: PROJECT_ID,
      title: "Assigned task",
      description: "",
      executionOwner: "human",
      assigneeIds: [member.participant.id],
    });
    expect(aiTask && humanTask).toBeTruthy();
    if (!aiTask || !humanTask) return;
    const app = createApp();

    const adminUpdate = await app.request(`/tasks/${aiTask.id}`, {
      method: "PUT",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({ paused: true }),
    });
    const assigneeUpdate = await app.request(`/tasks/${humanTask.id}/position`, {
      method: "PATCH",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({ position: 2_000 }),
    });

    expect(adminUpdate.status).toBe(200);
    expect(assigneeUpdate.status).toBe(200);
  });

  it("requires explicit resume action for manual plan-ready handoff and reports lock conflicts", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    testDb.current
      .insert(tasks)
      .values({
        id: "manual-plan-ready",
        projectId: PROJECT_ID,
        title: "Manual plan",
        status: "plan_ready",
        autoMode: false,
        executionOwner: "human",
      })
      .run();
    testDb.current
      .insert(taskAssignments)
      .values({
        taskId: "manual-plan-ready",
        participantId: member.participant.id,
        assignedByKind: "participant",
        assignedById: admin.participant.id,
      })
      .run();
    testDb.current
      .insert(tasks)
      .values({
        id: "locked-task",
        projectId: PROJECT_ID,
        title: "Locked",
        executionOwner: "ai",
        lockedBy: "agent:runtime",
        lockedUntil: new Date(Date.now() + 60_000).toISOString(),
      })
      .run();
    const app = createApp();

    const missingResume = await app.request("/tasks/manual-plan-ready/handoff", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        executionOwner: "ai",
        assigneeIds: [],
        expectedOwnershipRevision: 0,
      }),
    });
    expect(missingResume.status).toBe(409);
    expect(await missingResume.json()).toMatchObject({
      code: "invalid_ownership_transition",
    });

    const resumed = await app.request("/tasks/manual-plan-ready/handoff", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        executionOwner: "ai",
        assigneeIds: [],
        expectedOwnershipRevision: 0,
        resumeAction: "start_implementation",
      }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      task: { executionOwner: "ai", status: "implementing" },
    });

    const locked = await app.request("/tasks/locked-task/handoff", {
      method: "POST",
      headers: authHeaders(admin.session, true),
      body: JSON.stringify({
        executionOwner: "human",
        assigneeIds: [member.participant.id],
        expectedOwnershipRevision: 0,
      }),
    });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ code: "task_locked" });
  });

  it("attributes comments and human events to the authenticated participant", async () => {
    const member = await createAuthenticatedParticipant("member");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "Member task",
      description: "",
      executionOwner: "human",
      assigneeIds: [member.participant.id],
    });
    expect(task).toBeDefined();
    if (!task) return;
    const app = createApp();

    const comment = await app.request(`/tasks/${task.id}/comments`, {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({ message: "I am starting this task" }),
    });
    expect(comment.status).toBe(201);
    const commentBody = await comment.json();
    expect(commentBody).toMatchObject({
      author: "human",
      participantId: member.participant.id,
      participant: {
        id: member.participant.id,
        displayName: member.participant.displayName,
      },
    });
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "task:comment_created",
      payload: expect.objectContaining({
        taskId: task.id,
        comment: expect.objectContaining({ participantId: member.participant.id }),
        actor: expect.objectContaining({ id: member.participant.id }),
      }),
    });

    const event = await app.request(`/tasks/${task.id}/events`, {
      method: "POST",
      headers: authHeaders(member.session, true),
      body: JSON.stringify({ event: "start_human_work" }),
    });
    expect(event.status).toBe(200);
    expect(await event.json()).toMatchObject({
      status: "planning",
      permissions: expect.objectContaining({ canAct: true }),
    });

    const outsider = await createAuthenticatedParticipant("member");
    const denied = await app.request(`/tasks/${task.id}/events`, {
      method: "POST",
      headers: authHeaders(outsider.session, true),
      body: JSON.stringify({ event: "mark_plan_ready" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "assignment_required" });
  });

  it("returns immutable executor history through the API", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "History",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;
    const response = await createApp().request(`/tasks/${task.id}/executor-history`, {
      headers: { cookie: `${PARTICIPANT_COOKIE}=${admin.session.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        ownershipRevision: 0,
        executionOwner: "ai",
        reason: "task_created",
      }),
    ]);
  });
});
