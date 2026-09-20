import type { Context, Env, Hono } from "hono";
import { upgradeWebSocket as upgradeNodeServerV2WebSocket } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { WsEvent } from "@aif/shared";
import { getEnv, logger } from "@aif/shared";
import { isParticipantSessionActive, resolveParticipantSession } from "@aif/data";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLegacyWebSocketBridge } from "./legacyWebSocket.js";
import { participantRequestOriginIsAllowed } from "./middleware/csrf.js";

const log = logger("ws");

let clients: Set<WebSocket> = new Set();
const clientMap: Map<string, WebSocket> = new Map();
const socketToClientId: Map<WebSocket, string> = new Map();
const socketIdentity: Map<WebSocket, WebSocketIdentity> = new Map();

export interface WebSocketIdentity {
  participantId: string | null;
  sessionId: string | null;
  expiresAt: string | null;
}

export type WebSocketAuthorization =
  | { ok: true; identity: WebSocketIdentity }
  | {
      ok: false;
      status: 401 | 403 | 500;
      code: "authentication_required" | "invalid_origin" | "auth_store_error";
      error: string;
    };

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    const value = item.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export function authorizeWebSocketRequest(c: Context): WebSocketAuthorization {
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return {
      ok: true,
      identity: { participantId: null, sessionId: null, expiresAt: null },
    };
  }

  if (
    !participantRequestOriginIsAllowed({
      origin: c.req.header("origin"),
      allowedOrigins: env.PARTICIPANT_ALLOWED_ORIGINS,
    })
  ) {
    log.warn({ path: c.req.path }, "Rejected WebSocket request origin");
    return {
      ok: false,
      status: 403,
      code: "invalid_origin",
      error: "Invalid WebSocket origin",
    };
  }

  const token = cookieValue(c.req.header("cookie"), env.PARTICIPANT_SESSION_COOKIE_NAME);
  if (!token) {
    log.warn({ path: c.req.path }, "Rejected unauthenticated WebSocket request");
    return {
      ok: false,
      status: 401,
      code: "authentication_required",
      error: "Authentication required",
    };
  }
  try {
    const session = resolveParticipantSession(token);
    if (!session) {
      log.warn({ path: c.req.path }, "Rejected inactive WebSocket session");
      return {
        ok: false,
        status: 401,
        code: "authentication_required",
        error: "Authentication required",
      };
    }
    log.debug(
      {
        participantId: session.participant.id,
        sessionId: session.id,
      },
      "Authorized WebSocket request",
    );
    return {
      ok: true,
      identity: {
        participantId: session.participant.id,
        sessionId: session.id,
        expiresAt: session.expiresAt,
      },
    };
  } catch (error) {
    log.error({ error }, "WebSocket authentication store failed");
    return {
      ok: false,
      status: 500,
      code: "auth_store_error",
      error: "Authentication service unavailable",
    };
  }
}

function getRawWebSocket(ws: unknown): WebSocket | null {
  if (!ws || typeof ws !== "object") return null;
  const candidate = (ws as { raw?: unknown }).raw;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as WebSocket;
}

export interface WebSocketSetup {
  injectWebSocket?: (server: ServerType) => void;
  webSocketServer?: WebSocketServer;
}

function removeClient(raw: WebSocket): void {
  const clientId = socketToClientId.get(raw);
  clients.delete(raw);
  socketIdentity.delete(raw);
  if (clientId) {
    clientMap.delete(clientId);
    socketToClientId.delete(raw);
  }
}

function createWebSocketEvents(identity: WebSocketIdentity) {
  return {
    onOpen(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      const clientId = randomUUID();
      clients.add(raw);
      clientMap.set(clientId, raw);
      socketToClientId.set(raw, clientId);
      socketIdentity.set(raw, identity);
      log.debug(
        {
          clientId,
          participantId: identity.participantId,
          sessionId: identity.sessionId,
          clientCount: clients.size,
        },
        "WebSocket client connected",
      );
      raw.send(
        JSON.stringify({
          type: "ws:connected",
          payload: { clientId, participantId: identity.participantId },
        }),
      );
    },
    onClose(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      const clientId = socketToClientId.get(raw);
      const participantId = socketIdentity.get(raw)?.participantId ?? null;
      removeClient(raw);
      log.debug(
        { clientId, participantId, clientCount: clients.size },
        "WebSocket client disconnected",
      );
    },
    onError(error: Event) {
      log.error({ error }, "WebSocket error");
    },
  };
}

export function setupWebSocket<E extends Env>(
  app: Hono<E>,
  nodeServerV2Enabled = false,
): WebSocketSetup {
  const authorizedRequests = new WeakMap<Request, WebSocketIdentity>();
  const authorizeUpgrade = async (c: Context, next: () => Promise<void>) => {
    const authorization = authorizeWebSocketRequest(c);
    if (!authorization.ok) {
      return c.json({ error: authorization.error, code: authorization.code }, authorization.status);
    }
    authorizedRequests.set(c.req.raw, authorization.identity);
    await next();
  };
  const eventsForRequest = (c: Context) =>
    createWebSocketEvents(
      authorizedRequests.get(c.req.raw) ?? {
        participantId: null,
        sessionId: null,
        expiresAt: null,
      },
    );

  if (nodeServerV2Enabled) {
    const webSocketServer = new WebSocketServer({ noServer: true });
    app.get("/ws", authorizeUpgrade, upgradeNodeServerV2WebSocket(eventsForRequest));
    return { webSocketServer };
  }

  const legacyBridge = createLegacyWebSocketBridge(app);
  app.get(
    "/ws",
    authorizeUpgrade,
    legacyBridge.upgradeWebSocket(eventsForRequest, {
      onError(error) {
        log.error({ error }, "Legacy WebSocket handler error");
      },
    }),
  );

  return { injectWebSocket: legacyBridge.injectWebSocket };
}

export function sendToClient(clientId: string, event: WsEvent): boolean {
  disconnectInvalidWebSocketSessions();
  const client = clientMap.get(clientId);
  if (!client || client.readyState !== client.OPEN) {
    log.debug({ clientId, event: event.type }, "sendToClient: client not found or not open");
    return false;
  }
  client.send(JSON.stringify(event));
  log.debug({ clientId, event: event.type }, "Sent WS event to client");
  return true;
}

export function broadcast(event: WsEvent): void {
  if (event.type === "auth:session_revoked") {
    const payload = event.payload as { participantId?: unknown };
    if (typeof payload.participantId === "string") {
      const disconnected = disconnectParticipantWebSockets(payload.participantId);
      log.info(
        { event: event.type, participantId: payload.participantId, disconnected },
        "Delivered participant-targeted WS event",
      );
      return;
    }
  }
  disconnectInvalidWebSocketSessions();
  const data = JSON.stringify(event);
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
      sent++;
    }
  }
  log.info(
    { event: event.type, clientsSent: sent, clientsTotal: clients.size },
    "Broadcast WS event",
  );
}

export function getConnectedWebSocketClientCount(): number {
  return clients.size;
}

export function disconnectParticipantWebSockets(participantId: string): number {
  let disconnected = 0;
  for (const client of [...clients]) {
    if (socketIdentity.get(client)?.participantId !== participantId) continue;
    removeClient(client);
    client.terminate();
    disconnected += 1;
  }
  if (disconnected > 0) {
    log.info({ participantId, disconnected }, "Disconnected participant WebSocket sessions");
  }
  return disconnected;
}

export function disconnectInvalidWebSocketSessions(now = new Date()): number {
  let disconnected = 0;
  for (const client of [...clients]) {
    const identity = socketIdentity.get(client);
    if (!identity?.sessionId) continue;
    let active = false;
    try {
      active =
        Boolean(identity.expiresAt && identity.expiresAt > now.toISOString()) &&
        isParticipantSessionActive(identity.sessionId, now);
    } catch (error) {
      log.error(
        {
          error,
          participantId: identity.participantId,
          sessionId: identity.sessionId,
        },
        "WebSocket session validation failed",
      );
    }
    if (active) continue;
    removeClient(client);
    client.terminate();
    disconnected += 1;
  }
  if (disconnected > 0) {
    log.info({ disconnected }, "Disconnected invalid WebSocket sessions");
  }
  return disconnected;
}

setInterval(() => {
  disconnectInvalidWebSocketSessions();
}, 30_000).unref();

/**
 * Terminate all open WebSocket connections. Called on graceful shutdown so
 * the HTTP server can `close()` without waiting on long-lived WS clients
 * (which otherwise keep the event loop alive and block Ctrl+C).
 */
export function closeAllWebSocketClients(): void {
  const count = clients.size;
  for (const client of clients) {
    try {
      client.terminate();
    } catch {
      // Best-effort — socket may already be half-closed.
    }
  }
  clients.clear();
  clientMap.clear();
  socketToClientId.clear();
  socketIdentity.clear();
  if (count > 0) {
    log.info({ closed: count }, "Terminated all WebSocket clients on shutdown");
  }
}
