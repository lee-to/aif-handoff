import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  authenticateParticipant,
  changeParticipantPassword,
  revokeParticipantSession,
} from "@aif/data";
import { getEnv, logger, type AuditActor } from "@aif/shared";
import { changeParticipantPasswordSchema, participantLoginSchema } from "../schemas.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { broadcast } from "../ws.js";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("participant-auth-routes");

function sessionCookieIsSecure(requestUrl: string): boolean {
  const env = getEnv();
  return (
    env.PARTICIPANT_SESSION_COOKIE_SECURE ||
    process.env.NODE_ENV === "production" ||
    new URL(requestUrl).protocol === "https:"
  );
}

function createLoginRateLimiter() {
  const env = getEnv();
  return createRateLimiter({
    windowMs: env.PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.PARTICIPANT_LOGIN_RATE_LIMIT_MAX,
    skip: () => !getEnv().PARTICIPANTS_MODE_ENABLED,
    onLimit(c, resetAt) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
      c.header("Retry-After", String(retryAfterSeconds));
      log.warn({ retryAfterSeconds, path: c.req.path }, "Participant login rate limit exceeded");
      return c.json({ error: "Too many login attempts", code: "rate_limited" }, 429);
    },
  });
}

function createChangePasswordRateLimiter() {
  const env = getEnv();
  return createRateLimiter({
    windowMs: env.PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.PARTICIPANT_LOGIN_RATE_LIMIT_MAX,
    skip: () => !getEnv().PARTICIPANTS_MODE_ENABLED,
    onLimit(c, resetAt) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
      c.header("Retry-After", String(retryAfterSeconds));
      log.warn(
        { retryAfterSeconds, path: c.req.path },
        "Participant password change rate limit exceeded",
      );
      return c.json({ error: "Too many password attempts", code: "rate_limited" }, 429);
    },
  });
}

export const authRouter = new Hono<ParticipantApiEnv>();
const loginRateLimit = createLoginRateLimiter();
const changePasswordRateLimit = createChangePasswordRateLimiter();

authRouter.get("/session", (c) => {
  c.header("Cache-Control", "no-store");
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return c.json({
      participantsModeEnabled: false,
      authenticated: false,
      participant: null,
      csrfToken: null,
      expiresAt: null,
    });
  }

  const auth = getParticipantAuth(c);
  if (!auth.session) {
    return c.json({
      participantsModeEnabled: true,
      authenticated: false,
      participant: null,
      csrfToken: null,
      expiresAt: null,
    });
  }

  return c.json({
    participantsModeEnabled: true,
    authenticated: true,
    participant: auth.session.participant,
    csrfToken: auth.session.csrfToken,
    expiresAt: auth.session.expiresAt,
  });
});

authRouter.post("/login", loginRateLimit, jsonValidator(participantLoginSchema), async (c) => {
  c.header("Cache-Control", "no-store");
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return c.json(
      { error: "Participants Mode is disabled", code: "participants_mode_disabled" },
      409,
    );
  }

  const input = c.req.valid("json");
  try {
    const result = await authenticateParticipant(input.username, input.password, {
      sessionTtlMs: env.PARTICIPANT_SESSION_TTL_SECONDS * 1_000,
    });
    if (!result.ok) {
      log.warn({ accountSupplied: true }, "Participant login failed");
      return c.json({ error: "Invalid username or password", code: "invalid_credentials" }, 401);
    }

    setCookie(c, env.PARTICIPANT_SESSION_COOKIE_NAME, result.session.token, {
      httpOnly: true,
      secure: sessionCookieIsSecure(c.req.url),
      sameSite: "Strict",
      path: "/",
      maxAge: env.PARTICIPANT_SESSION_TTL_SECONDS,
      expires: new Date(result.session.expiresAt),
    });
    log.info(
      {
        participantId: result.session.participant.id,
        sessionId: result.session.id,
      },
      "Participant login completed",
    );
    return c.json({
      participantsModeEnabled: true,
      authenticated: true,
      participant: result.session.participant,
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
    });
  } catch (error) {
    log.error({ error }, "Participant login store failed");
    return c.json({ error: "Authentication service unavailable", code: "auth_store_error" }, 500);
  }
});

authRouter.post(
  "/change-password",
  changePasswordRateLimit,
  jsonValidator(changeParticipantPasswordSchema),
  async (c) => {
    c.header("Cache-Control", "no-store");
    if (!getEnv().PARTICIPANTS_MODE_ENABLED) {
      return c.json(
        { error: "Participants Mode is disabled", code: "participants_mode_disabled" },
        409,
      );
    }

    const auth = getParticipantAuth(c);
    if (!auth.session) {
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }
    const { currentPassword, newPassword } = c.req.valid("json");
    const actor: AuditActor = {
      kind: "participant",
      id: auth.session.participant.id,
      displayNameSnapshot: auth.session.participant.displayName,
    };

    try {
      const result = await changeParticipantPassword(
        auth.session.participant.id,
        currentPassword,
        newPassword,
        auth.session.id,
        actor,
      );
      if (!result.ok) {
        if (result.code === "invalid_current_password") {
          return c.json({ error: "Current password is incorrect", code: result.code }, 403);
        }
        if (result.code === "inactive_participant") {
          return c.json({ error: "Participant is inactive", code: result.code }, 409);
        }
        if (result.code === "not_found") {
          return c.json({ error: "Participant not found", code: result.code }, 404);
        }
        return c.json({ error: "Invalid password input", code: result.code }, 400);
      }

      log.info(
        {
          participantId: result.participant.id,
          sessionId: auth.session.id,
          revokedSessionCount: result.revokedSessionCount ?? 0,
        },
        "Participant password change completed",
      );
      broadcast({
        type: "participant:updated",
        payload: { participant: result.participant, actor },
      });
      return c.json({ ok: true, revokedSessionCount: result.revokedSessionCount ?? 0 });
    } catch (error) {
      log.error(
        { error, participantId: auth.session.participant.id, sessionId: auth.session.id },
        "Participant password change failed",
      );
      return c.json({ error: "Authentication service unavailable", code: "auth_store_error" }, 500);
    }
  },
);

authRouter.post("/logout", (c) => {
  c.header("Cache-Control", "no-store");
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return c.json(
      { error: "Participants Mode is disabled", code: "participants_mode_disabled" },
      409,
    );
  }

  const auth = getParticipantAuth(c);
  if (!auth.session || !auth.sessionToken) {
    return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
  }

  try {
    revokeParticipantSession(auth.sessionToken);
    deleteCookie(c, env.PARTICIPANT_SESSION_COOKIE_NAME, {
      path: "/",
      secure: sessionCookieIsSecure(c.req.url),
    });
    log.info(
      {
        participantId: auth.session.participant.id,
        sessionId: auth.session.id,
      },
      "Participant logout completed",
    );
    broadcast({
      type: "auth:session_revoked",
      payload: { participantId: auth.session.participant.id },
    });
    return c.json({ ok: true });
  } catch (error) {
    log.error(
      {
        error,
        participantId: auth.session.participant.id,
        sessionId: auth.session.id,
      },
      "Participant logout store failed",
    );
    return c.json({ error: "Authentication service unavailable", code: "auth_store_error" }, 500);
  }
});
