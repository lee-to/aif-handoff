import type { MiddlewareHandler } from "hono";
import { verifyParticipantSessionCsrf } from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "./participantAuth.js";

const log = logger("participant-csrf");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizedOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === value.replace(/\/$/, "") ? parsed.origin : null;
  } catch {
    return null;
  }
}

function hasAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  const normalized = normalizedOrigin(origin);
  return normalized !== null && allowedOrigins.includes(normalized);
}

export function participantRequestOriginIsAllowed(input: {
  origin: string | undefined;
  allowedOrigins: readonly string[];
}): boolean {
  return hasAllowedOrigin(input.origin, input.allowedOrigins);
}

export function participantCsrf(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const env = getEnv();
    const auth = getParticipantAuth(c);
    if (
      !env.PARTICIPANTS_MODE_ENABLED ||
      auth.mode === "disabled" ||
      auth.mode === "internal" ||
      SAFE_METHODS.has(c.req.method)
    ) {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    if (
      !participantRequestOriginIsAllowed({
        origin,
        allowedOrigins: env.PARTICIPANT_ALLOWED_ORIGINS,
      })
    ) {
      log.warn(
        { method: c.req.method, path: c.req.path, hasOrigin: Boolean(origin) },
        "Rejected participant request origin",
      );
      return c.json({ error: "Invalid request origin", code: "invalid_origin" }, 403);
    }

    if (c.req.path === "/auth/login") {
      await next();
      return;
    }

    if (!auth.session || !auth.sessionToken) {
      log.warn({ method: c.req.method, path: c.req.path }, "Rejected CSRF without session");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }

    const csrfToken = c.req.header("x-csrf-token");
    let csrfIsValid = false;
    try {
      csrfIsValid = Boolean(
        csrfToken && verifyParticipantSessionCsrf(auth.sessionToken, csrfToken),
      );
    } catch (error) {
      log.error(
        {
          error,
          participantId: auth.session.participant.id,
          sessionId: auth.session.id,
          path: c.req.path,
        },
        "Participant CSRF store failed",
      );
      return c.json({ error: "Authentication service unavailable", code: "auth_store_error" }, 500);
    }
    if (!csrfIsValid) {
      log.warn(
        {
          participantId: auth.session.participant.id,
          sessionId: auth.session.id,
          method: c.req.method,
          path: c.req.path,
        },
        "Rejected participant CSRF token",
      );
      return c.json({ error: "Invalid CSRF token", code: "invalid_csrf" }, 403);
    }

    await next();
  };
}
