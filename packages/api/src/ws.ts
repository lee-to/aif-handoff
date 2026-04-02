import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WsEvent } from "@aif/shared";
import { logger } from "@aif/shared";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const log = logger("ws");

let clients: Set<WebSocket> = new Set();
const clientMap: Map<string, WebSocket> = new Map();
const socketToClientId: Map<WebSocket, string> = new Map();
let injectWebSocketFn: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];

function getRawWebSocket(ws: unknown): WebSocket | null {
  if (!ws || typeof ws !== "object") return null;
  const candidate = (ws as { raw?: unknown }).raw;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as WebSocket;
}

export function setupWebSocket(app: Hono) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  injectWebSocketFn = injectWebSocket;

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
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
    })),
  );

  return { injectWebSocket, upgradeWebSocket };
}

export function getInjectWebSocket() {
  return injectWebSocketFn;
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
