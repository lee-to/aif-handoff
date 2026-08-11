import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveParticipantSession, type ResolvedParticipantSession } from "@aif/data";
import { getEnv, logger } from "@aif/shared";

const log = logger("participant-auth");

export interface ParticipantAuthContext {
  mode: "disabled" | "participant" | "internal";
  session: ResolvedParticipantSession | null;
  sessionToken: string | null;
}

export interface ParticipantApiEnv {
  Variables: {
    participantAuth: ParticipantAuthContext;
  };
}

function tokensMatch(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return (
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function isTrustedInternalPath(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return (
    /^\/tasks\/[^/]+\/broadcast$/.test(path) ||
    /^\/projects\/[^/]+\/broadcast$/.test(path) ||
    /^\/projects\/[^/]+\/github\/sync$/.test(path) ||
    /^\/projects\/[^/]+\/github\/tasks\/[^/]+\/publish$/.test(path)
  );
}

function isPublicParticipantPath(method: string, path: string): boolean {
  return (
    method === "OPTIONS" ||
    (method === "GET" && path === "/health") ||
    (method === "GET" && path === "/auth/session") ||
    (method === "POST" && path === "/auth/login")
  );
}

function hasTrustedInternalToken(c: Context): boolean {
  const configured = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  if (!configured) return false;
  const candidate =
    c.req.header("x-internal-broadcast-token") ?? bearerToken(c.req.header("authorization"));
  return tokensMatch(candidate, configured);
}

export function getParticipantAuth(c: Context<ParticipantApiEnv>): ParticipantAuthContext {
  return c.get("participantAuth");
}

export function createParticipantAuthMiddleware(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const env = getEnv();
    if (!env.PARTICIPANTS_MODE_ENABLED) {
      c.set("participantAuth", {
        mode: "disabled",
        session: null,
        sessionToken: null,
      });
      await next();
      return;
    }

    if (isTrustedInternalPath(c.req.method, c.req.path) && hasTrustedInternalToken(c)) {
      c.set("participantAuth", {
        mode: "internal",
        session: null,
        sessionToken: null,
      });
      log.debug({ path: c.req.path }, "Authorized participant middleware internal bypass");
      await next();
      return;
    }

    const token = getCookie(c, env.PARTICIPANT_SESSION_COOKIE_NAME) ?? null;
    if (token) {
      try {
        const session = resolveParticipantSession(token);
        if (session) {
          c.set("participantAuth", {
            mode: "participant",
            session,
            sessionToken: token,
          });
          log.debug(
            {
              participantId: session.participant.id,
              sessionId: session.id,
              path: c.req.path,
            },
            "Resolved participant request session",
          );
          await next();
          return;
        }
      } catch (error) {
        log.error({ error, path: c.req.path }, "Participant auth store failed");
        return c.json(
          { error: "Authentication service unavailable", code: "auth_store_error" },
          500,
        );
      }
    }

    c.set("participantAuth", {
      mode: "participant",
      session: null,
      sessionToken: null,
    });
    if (isPublicParticipantPath(c.req.method, c.req.path)) {
      await next();
      return;
    }

    log.warn({ method: c.req.method, path: c.req.path }, "Rejected unauthenticated request");
    return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
  };
}

export const participantAuth = createParticipantAuthMiddleware();
