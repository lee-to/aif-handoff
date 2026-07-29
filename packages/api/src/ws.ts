import type { Hono } from "hono";
import { upgradeWebSocket as upgradeNodeServerV2WebSocket } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { WsEvent } from "@aif/shared";
import { logger } from "@aif/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLegacyWebSocketBridge } from "./legacyWebSocket.js";

const log = logger("ws");

let clients: Set<WebSocket> = new Set();
const clientMap: Map<string, WebSocket> = new Map();
const socketToClientId: Map<WebSocket, string> = new Map();

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

function createWebSocketEvents() {
  return {
    onOpen(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      const clientId = randomUUID();
      clients.add(raw);
      clientMap.set(clientId, raw);
      socketToClientId.set(raw, clientId);
      log.debug({ clientId, clientCount: clients.size }, "WebSocket client connected");
      raw.send(JSON.stringify({ type: "ws:connected", payload: { clientId } }));
    },
    onClose(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      const clientId = socketToClientId.get(raw);
      clients.delete(raw);
      if (clientId) {
        clientMap.delete(clientId);
        socketToClientId.delete(raw);
      }
      log.debug({ clientId, clientCount: clients.size }, "WebSocket client disconnected");
    },
    onError(error: Event) {
      log.error({ error }, "WebSocket error");
    },
  };
}

export function setupWebSocket(app: Hono, nodeServerV2Enabled = false): WebSocketSetup {
  if (nodeServerV2Enabled) {
    const webSocketServer = new WebSocketServer({ noServer: true });
    app.get(
      "/ws",
      upgradeNodeServerV2WebSocket(() => createWebSocketEvents()),
    );
    return { webSocketServer };
  }

  const legacyBridge = createLegacyWebSocketBridge(app);
  app.get(
    "/ws",
    legacyBridge.upgradeWebSocket(() => createWebSocketEvents(), {
      onError(error) {
        log.error({ error }, "Legacy WebSocket handler error");
      },
    }),
  );

  return { injectWebSocket: legacyBridge.injectWebSocket };
}

export function sendToClient(clientId: string, event: WsEvent): boolean {
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
  if (count > 0) {
    log.info({ closed: count }, "Terminated all WebSocket clients on shutdown");
  }
}
