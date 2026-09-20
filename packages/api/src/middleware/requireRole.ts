import type { MiddlewareHandler } from "hono";
import { logger, type ParticipantRole } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "./participantAuth.js";

const log = logger("participant-authorization");

export function requireParticipant(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const auth = getParticipantAuth(c);
    if (auth.mode === "disabled" || auth.mode === "internal") {
      await next();
      return;
    }
    if (!auth.session) {
      log.warn({ method: c.req.method, path: c.req.path }, "Participant session required");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }
    await next();
  };
}

export function requireRole(role: ParticipantRole): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const auth = getParticipantAuth(c);
    if (auth.mode === "disabled" || auth.mode === "internal") {
      await next();
      return;
    }
    if (!auth.session) {
      log.warn({ method: c.req.method, path: c.req.path }, "Participant session required");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }
    if (auth.session.participant.role !== role) {
      log.warn(
        {
          participantId: auth.session.participant.id,
          requiredRole: role,
          actualRole: auth.session.participant.role,
          method: c.req.method,
          path: c.req.path,
        },
        "Rejected participant authorization",
      );
      return c.json({ error: "Insufficient permissions", code: "forbidden" }, 403);
    }
    await next();
  };
}

export function isAdminOnlyRoute(method: string, path: string): boolean {
  const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (path.startsWith("/participants")) return true;
  if (path.startsWith("/auth/codex") && path !== "/auth/codex/capabilities") return true;
  if (unsafe && path.startsWith("/projects")) {
    return !/^\/projects\/[^/]+\/broadcast$/.test(path);
  }
  if (unsafe && path.startsWith("/settings")) return true;
  if (unsafe && path.startsWith("/runtime-profiles")) return true;
  if (method === "DELETE" && (path.startsWith("/tasks/") || path.startsWith("/chat/"))) {
    return true;
  }
  return false;
}

export function participantRouteAuthorization(): MiddlewareHandler<ParticipantApiEnv> {
  const memberGuard = requireParticipant();
  const adminGuard = requireRole("admin");
  return async (c, next) => {
    if (
      c.req.method === "OPTIONS" ||
      (c.req.method === "GET" && (c.req.path === "/health" || c.req.path === "/auth/session")) ||
      (c.req.method === "POST" && c.req.path === "/auth/login")
    ) {
      await next();
      return;
    }
    if (isAdminOnlyRoute(c.req.method, c.req.path)) {
      return adminGuard(c, next);
    }
    return memberGuard(c, next);
  };
}
