import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { taskAssignments, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const testDb = { current: createTestDb() };
const mockBroadcast = vi.fn();
const PARTICIPANT_COOKIE = "test_participant_session";
const ORIGIN = "http://localhost:5180";

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

const { createParticipant, createParticipantSession, getTaskOwnership, resolveParticipantSession } =
  await import("@aif/data");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { participantsRouter } = await import("../routes/participants.js");

function createApp() {
  const app = new Hono<ParticipantApiEnv>();
  app.use("*", participantAuth);
  app.use("*", participantRouteAuthorization());
  app.use("*", participantCsrf());
  app.route("/participants", participantsRouter);
  return app;
}

async function createAuthenticatedParticipant(role: "admin" | "member") {
  const id = crypto.randomUUID();
  const result = await createParticipant({
    username: `${role}-${id}`,
    displayName: role === "admin" ? `Admin ${id}` : `Member ${id}`,
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

function authenticatedHeaders(session: { token: string; csrfToken: string }) {
  return {
    cookie: `${PARTICIPANT_COOKIE}=${session.token}`,
    origin: ORIGIN,
    "x-csrf-token": session.csrfToken,
  };
}

beforeEach(() => {
  testDb.current = createTestDb();
  mockBroadcast.mockReset();
});

describe("participant administration API", () => {
  it("denies members and allows admins to list active or inactive participants", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const app = createApp();

    const denied = await app.request("/participants", {
      headers: { cookie: `${PARTICIPANT_COOKIE}=${member.session.token}` },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "forbidden" });

    const deactivation = await app.request(`/participants/${member.participant.id}/deactivate`, {
      method: "POST",
      headers: authenticatedHeaders(admin.session),
    });
    expect(deactivation.status).toBe(200);

    const activeOnly = await app.request("/participants", {
      headers: { cookie: `${PARTICIPANT_COOKIE}=${admin.session.token}` },
    });
    expect((await activeOnly.json()).map((participant: { id: string }) => participant.id)).toEqual([
      admin.participant.id,
    ]);

    const all = await app.request("/participants?includeInactive=true", {
      headers: { cookie: `${PARTICIPANT_COOKIE}=${admin.session.token}` },
    });
    expect(await all.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: admin.participant.id, active: true }),
        expect.objectContaining({ id: member.participant.id, active: false }),
      ]),
    );
  });

  it("creates participants without returning credentials and reports duplicate conflicts", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const payload = {
      username: "new-member",
      displayName: "New Member",
      password: "never-return-this-password",
      role: "member",
    };
    const response = await app.request("/participants", {
      method: "POST",
      headers: {
        ...authenticatedHeaders(admin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      username: "new-member",
      displayName: "New Member",
      role: "member",
    });
    expect(JSON.stringify(body)).not.toContain(payload.password);
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("passwordHash");
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "participant:created" }),
    );

    const duplicate = await app.request("/participants", {
      method: "POST",
      headers: {
        ...authenticatedHeaders(admin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "duplicate_username" });
  });

  it("protects the final active admin and revokes sessions after a role change", async () => {
    const firstAdmin = await createAuthenticatedParticipant("admin");
    const app = createApp();
    const finalAdmin = await app.request(`/participants/${firstAdmin.participant.id}`, {
      method: "PATCH",
      headers: {
        ...authenticatedHeaders(firstAdmin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "member" }),
    });
    expect(finalAdmin.status).toBe(409);
    expect(await finalAdmin.json()).toMatchObject({ code: "final_active_admin" });

    const secondAdmin = await createAuthenticatedParticipant("admin");
    const demoted = await app.request(`/participants/${firstAdmin.participant.id}`, {
      method: "PATCH",
      headers: {
        ...authenticatedHeaders(secondAdmin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "member" }),
    });
    expect(demoted.status).toBe(200);
    expect(await demoted.json()).toMatchObject({ role: "member" });
    expect(resolveParticipantSession(firstAdmin.session.token)).toBeNull();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "auth:session_revoked",
      payload: { participantId: firstAdmin.participant.id },
    });
  });

  it("resets a password, invalidates sessions, and never echoes the new password", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const app = createApp();
    const password = "new private password";
    const response = await app.request(`/participants/${member.participant.id}/reset-password`, {
      method: "POST",
      headers: {
        ...authenticatedHeaders(admin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ password }),
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(password);
    expect(resolveParticipantSession(member.session.token)).toBeNull();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "auth:session_revoked",
      payload: { participantId: member.participant.id },
    });
  });

  it("deactivates a participant, clears assignments, invalidates sessions, and broadcasts changes", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    testDb.current
      .insert(tasks)
      .values({
        id: "assigned-task",
        projectId: "project",
        title: "Assigned",
        executionOwner: "human",
      })
      .run();
    testDb.current
      .insert(taskAssignments)
      .values({
        taskId: "assigned-task",
        participantId: member.participant.id,
        assignedByKind: "participant",
        assignedById: admin.participant.id,
      })
      .run();
    const app = createApp();
    const response = await app.request(`/participants/${member.participant.id}/deactivate`, {
      method: "POST",
      headers: authenticatedHeaders(admin.session),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ active: false });
    expect(resolveParticipantSession(member.session.token)).toBeNull();
    expect(getTaskOwnership("assigned-task")?.assignees).toEqual([]);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "participant:deactivated" }),
    );
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "task:updated",
      payload: expect.objectContaining({
        id: "assigned-task",
        title: "Assigned",
        status: "backlog",
      }),
    });
  });

  it("returns validation, missing, and inactive errors consistently", async () => {
    const admin = await createAuthenticatedParticipant("admin");
    const member = await createAuthenticatedParticipant("member");
    const app = createApp();

    const weakPassword = await app.request("/participants", {
      method: "POST",
      headers: {
        ...authenticatedHeaders(admin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "weak",
        displayName: "Weak",
        password: "short",
      }),
    });
    expect(weakPassword.status).toBe(400);

    const missing = await app.request("/participants/missing/deactivate", {
      method: "POST",
      headers: authenticatedHeaders(admin.session),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });

    expect(
      (
        await app.request(`/participants/${member.participant.id}/deactivate`, {
          method: "POST",
          headers: authenticatedHeaders(admin.session),
        })
      ).status,
    ).toBe(200);
    const inactive = await app.request(`/participants/${member.participant.id}`, {
      method: "PATCH",
      headers: {
        ...authenticatedHeaders(admin.session),
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Cannot change" }),
    });
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ code: "inactive_participant" });
  });
});
