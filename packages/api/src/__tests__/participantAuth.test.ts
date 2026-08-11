import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "@aif/shared/server";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const testDb = { current: createTestDb() };
const securityConfig = {
  enabled: true,
  internalToken: "internal-secret",
  secureCookie: false,
};

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  const defaults = actual.validateEnv({});
  return {
    ...actual,
    getEnv: () => ({
      ...defaults,
      PARTICIPANTS_MODE_ENABLED: securityConfig.enabled,
      PARTICIPANT_SESSION_TTL_SECONDS: 3_600,
      PARTICIPANT_SESSION_COOKIE_NAME: "test_participant_session",
      PARTICIPANT_SESSION_COOKIE_SECURE: securityConfig.secureCookie,
      PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS: 60_000,
      PARTICIPANT_LOGIN_RATE_LIMIT_MAX: 3,
      PARTICIPANT_ALLOWED_ORIGINS: ["http://localhost:5180", "https://team.example.test"],
      INTERNAL_BROADCAST_TOKEN: securityConfig.internalToken,
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

const {
  createParticipant,
  createParticipantSession,
  deactivateParticipant,
  resetParticipantPassword,
} = await import("@aif/data");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { participantCors } = await import("../middleware/participantCors.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { internalBroadcastAuth } = await import("../middleware/internalBroadcastAuth.js");
const { authRouter } = await import("../routes/auth.js");

const ALLOWED_ORIGIN = "http://localhost:5180";

function createApp(options: { cors?: boolean } = {}) {
  const app = new Hono<ParticipantApiEnv>();
  if (options.cors) app.use("*", participantCors());
  app.use("*", participantAuth);
  app.use("*", participantRouteAuthorization());
  app.use("*", participantCsrf());
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/auth", authRouter);
  app.get("/board", (c) => c.json({ ok: true }));
  app.post("/tasks/example/comments", (c) => c.json({ ok: true }));
  app.delete("/tasks/example", (c) => c.json({ ok: true }));
  app.post("/projects", (c) => c.json({ ok: true }));
  app.post("/tasks/example/broadcast", internalBroadcastAuth, (c) => c.json({ ok: true }));
  return app;
}

function cookieHeader(token: string): string {
  return `test_participant_session=${token}`;
}

async function createSession(role: "admin" | "member" = "member") {
  const id = crypto.randomUUID();
  const created = await createParticipant({
    username: `user-${id}`,
    displayName: role === "admin" ? "Test Admin" : "Test Member",
    password: "correct horse battery staple",
    role,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("participant creation failed");
  const session = createParticipantSession(created.participant.id, {
    ttlMs: 60_000,
  });
  expect(session).not.toBeNull();
  if (!session) throw new Error("session creation failed");
  return { participant: created.participant, session };
}

beforeEach(() => {
  testDb.current = createTestDb();
  securityConfig.enabled = true;
  securityConfig.internalToken = "internal-secret";
  securityConfig.secureCookie = false;
});

describe("Participants Mode authentication", () => {
  it("preserves anonymous compatibility while disabled", async () => {
    securityConfig.enabled = false;
    const app = createApp();

    expect((await app.request("/board")).status).toBe(200);
    expect(
      (
        await app.request("/tasks/example/comments", {
          method: "POST",
        })
      ).status,
    ).toBe(200);

    const session = await app.request("/auth/session");
    expect(await session.json()).toMatchObject({
      participantsModeEnabled: false,
      authenticated: false,
    });
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ignored", password: "ignored" }),
    });
    expect(login.status).toBe(409);
    expect(await login.json()).toMatchObject({ code: "participants_mode_disabled" });
  });

  it("logs in with an opaque cookie and resolves the session without returning the cookie token", async () => {
    await createParticipant({
      username: "alice",
      displayName: "Alice Admin",
      password: "safe login password",
      role: "admin",
    });
    const app = createApp();
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
        "x-forwarded-for": "198.51.100.10",
      },
      body: JSON.stringify({ username: "ALICE", password: "safe login password" }),
    });

    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body).toMatchObject({
      participantsModeEnabled: true,
      authenticated: true,
      participant: { displayName: "Alice Admin", role: "admin" },
    });
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("test_participant_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain(String(body.csrfToken));

    const cookiePair = cookie?.split(";")[0] ?? "";
    const session = await app.request("/auth/session", {
      headers: { cookie: cookiePair },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      participant: { displayName: "Alice Admin" },
      csrfToken: body.csrfToken,
    });
  });

  it("sets the Secure cookie flag when configured", async () => {
    securityConfig.secureCookie = true;
    await createParticipant({
      username: "secure",
      displayName: "Secure User",
      password: "safe login password",
    });
    const response = await createApp().request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
        "x-forwarded-for": "198.51.100.15",
      },
      body: JSON.stringify({ username: "secure", password: "safe login password" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("lets a member change their own password without ending the current session", async () => {
    const { participant, session } = await createSession("member");
    const otherSession = createParticipantSession(participant.id, { ttlMs: 60_000 });
    expect(otherSession).not.toBeNull();
    if (!otherSession) return;
    const app = createApp();

    const wrongPassword = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({
        currentPassword: "wrong current password",
        newPassword: "new secure password",
      }),
    });
    expect(wrongPassword.status).toBe(403);
    expect(await wrongPassword.json()).toMatchObject({ code: "invalid_current_password" });

    const changed = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({
        currentPassword: "correct horse battery staple",
        newPassword: "new secure password",
      }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ok: true, revokedSessionCount: 1 });
    expect(
      (
        await app.request("/board", {
          headers: { cookie: cookieHeader(session.token) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/board", {
          headers: { cookie: cookieHeader(otherSession.token) },
        })
      ).status,
    ).toBe(401);
  });

  it("uses the same response for unknown, inactive, and wrong-password credentials", async () => {
    const active = await createParticipant({
      username: "active",
      displayName: "Active",
      password: "correct password",
    });
    const inactive = await createParticipant({
      username: "inactive",
      displayName: "Inactive",
      password: "correct password",
    });
    expect(active.ok && inactive.ok).toBe(true);
    if (!inactive.ok) return;
    deactivateParticipant(inactive.participant.id);
    const app = createApp();

    const attempts = [
      { username: "missing", password: "correct password", ip: "198.51.100.11" },
      { username: "inactive", password: "correct password", ip: "198.51.100.12" },
      { username: "active", password: "wrong password", ip: "198.51.100.13" },
    ];
    for (const attempt of attempts) {
      const response = await app.request("/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ALLOWED_ORIGIN,
          "x-forwarded-for": attempt.ip,
        },
        body: JSON.stringify({ username: attempt.username, password: attempt.password }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "Invalid username or password",
        code: "invalid_credentials",
      });
    }
  });

  it("rate limits login attempts with a structured response", async () => {
    const app = createApp();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.request("/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ALLOWED_ORIGIN,
          "x-forwarded-for": "198.51.100.14",
        },
        body: JSON.stringify({ username: "missing", password: "wrong" }),
      });
      expect(response.status).toBe(401);
    }

    const limited = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
        "x-forwarded-for": "198.51.100.14",
      },
      body: JSON.stringify({ username: "missing", password: "wrong" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
  });

  it("rejects expired, deactivated, and password-reset sessions", async () => {
    const app = createApp();

    const expiredParticipant = await createParticipant({
      username: "expired",
      displayName: "Expired",
      password: "old password",
    });
    expect(expiredParticipant.ok).toBe(true);
    if (!expiredParticipant.ok) return;
    const expiredSession = createParticipantSession(expiredParticipant.participant.id, {
      ttlMs: 1_000,
      now: new Date(Date.now() - 2_000),
    });
    expect(expiredSession).not.toBeNull();

    const deactivated = await createSession();
    deactivateParticipant(deactivated.participant.id);
    const reset = await createSession();
    await resetParticipantPassword(reset.participant.id, "new safe password");

    for (const token of [
      expiredSession?.token ?? "",
      deactivated.session.token,
      reset.session.token,
    ]) {
      const response = await app.request("/board", {
        headers: { cookie: cookieHeader(token) },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "authentication_required" });
    }
  });
});

describe("Participants Mode request security", () => {
  it("requires an exact allowed origin and session-bound CSRF on unsafe requests", async () => {
    const { session } = await createSession();
    const app = createApp();

    const missingOrigin = await app.request("/tasks/example/comments", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(missingOrigin.status).toBe(403);
    expect(await missingOrigin.json()).toMatchObject({ code: "invalid_origin" });

    const evilOrigin = await app.request("/tasks/example/comments", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        origin: "https://team.example.test.evil.invalid",
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(evilOrigin.status).toBe(403);

    const crossHost = await app.request("/tasks/example/comments", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        host: "api.example.test",
        origin: ALLOWED_ORIGIN,
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(crossHost.status).toBe(200);

    const missingCsrf = await app.request("/tasks/example/comments", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        origin: ALLOWED_ORIGIN,
      },
    });
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toMatchObject({ code: "invalid_csrf" });

    const accepted = await app.request("/tasks/example/comments", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.token),
        origin: ALLOWED_ORIGIN,
        "x-csrf-token": session.csrfToken,
      },
    });
    expect(accepted.status).toBe(200);
  });

  it("enforces member/admin route roles and keeps structured 401/403 errors", async () => {
    const member = await createSession("member");
    const admin = await createSession("admin");
    const app = createApp();

    const unauthenticated = await app.request("/board");
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: "authentication_required" });

    expect(
      (
        await app.request("/board", {
          headers: { cookie: cookieHeader(member.session.token) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/tasks/example/comments", {
          method: "POST",
          headers: {
            cookie: cookieHeader(member.session.token),
            origin: ALLOWED_ORIGIN,
            "x-csrf-token": member.session.csrfToken,
          },
        })
      ).status,
    ).toBe(200);

    for (const path of ["/projects", "/tasks/example"]) {
      const method = path === "/projects" ? "POST" : "DELETE";
      const forbidden = await app.request(path, {
        method,
        headers: {
          cookie: cookieHeader(member.session.token),
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": member.session.csrfToken,
        },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ code: "forbidden" });

      const accepted = await app.request(path, {
        method,
        headers: {
          cookie: cookieHeader(admin.session.token),
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": admin.session.csrfToken,
        },
      });
      expect(accepted.status).toBe(200);
    }
  });

  it("isolates internal broadcasts behind their separate token without CSRF", async () => {
    const app = createApp();

    const missing = await app.request("/tasks/example/broadcast", { method: "POST" });
    expect(missing.status).toBe(401);

    const invalid = await app.request("/tasks/example/broadcast", {
      method: "POST",
      headers: { "x-internal-broadcast-token": "wrong" },
    });
    expect(invalid.status).toBe(401);

    const accepted = await app.request("/tasks/example/broadcast", {
      method: "POST",
      headers: { "x-internal-broadcast-token": securityConfig.internalToken },
    });
    expect(accepted.status).toBe(200);
  });

  it("does not trust client-supplied proxy addresses for internal broadcasts", async () => {
    securityConfig.enabled = false;
    securityConfig.internalToken = "";
    vi.stubEnv("NODE_ENV", "development");
    try {
      const response = await createApp().request("/tasks/example/broadcast", {
        method: "POST",
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(response.status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("emits credentialed CORS headers only for exact configured origins", async () => {
    const app = createApp({ cors: true });

    const allowed = await app.request("/auth/session", {
      headers: { origin: "https://team.example.test" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://team.example.test");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const rejected = await app.request("/auth/session", {
      headers: { origin: "https://team.example.test.evil.invalid" },
    });
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });
});
