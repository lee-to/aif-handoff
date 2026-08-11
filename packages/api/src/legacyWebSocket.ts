import type { ServerType } from "@hono/node-server";
import type { Env, Hono } from "hono";
import {
  defineWebSocketHelper,
  WSContext,
  type UpgradeWebSocket,
  type WSMessageReceive,
  type WSReadyState,
} from "hono/ws";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

export interface LegacyWebSocketBridge {
  injectWebSocket(server: ServerType): void;
  upgradeWebSocket: UpgradeWebSocket<WebSocket, { onError?: (error: unknown) => void }>;
}

const LEGACY_CONNECTION_SYMBOL: unique symbol = Symbol("legacy-websocket-connection");

interface LegacyWebSocketBindings {
  incoming: IncomingMessage;
  outgoing: undefined;
  [LEGACY_CONNECTION_SYMBOL]?: symbol;
}

interface PendingWebSocket {
  connectionSymbol: symbol;
  resolve: (webSocket: WebSocket) => void;
}

function toReadyState(value: number): WSReadyState {
  if (value === 0 || value === 1 || value === 2) {
    return value;
  }
  return 3;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function toMessageData(data: RawData, isBinary: boolean): WSMessageReceive {
  const buffer = toBuffer(data);
  if (!isBinary) {
    return buffer.toString("utf8");
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function buildRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, rawValue] of Object.entries(request.headers)) {
    if (rawValue == null) {
      continue;
    }
    headers.append(key, Array.isArray(rawValue) ? rawValue[0] : rawValue);
  }
  return headers;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}

export function createLegacyWebSocketBridge<E extends Env>(app: Hono<E>): LegacyWebSocketBridge {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const pendingWebSockets = new Map<IncomingMessage, PendingWebSocket>();

  webSocketServer.on("connection", (webSocket, request) => {
    const pending = pendingWebSockets.get(request);
    if (!pending) {
      return;
    }
    pending.resolve(webSocket);
    pendingWebSockets.delete(request);
  });

  const waitForWebSocket = (
    request: IncomingMessage,
    connectionSymbol: symbol,
  ): Promise<WebSocket> =>
    new Promise((resolve) => {
      pendingWebSockets.set(request, { connectionSymbol, resolve });
    });

  const upgradeWebSocket = defineWebSocketHelper<WebSocket, { onError?: (error: unknown) => void }>(
    async (context, events, options) => {
      if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return;
      }

      const bindings = context.env as LegacyWebSocketBindings;
      if (!bindings.incoming) {
        return new Response(null, { status: 500 });
      }

      const connectionSymbol = Symbol("legacy-websocket-request");
      bindings[LEGACY_CONNECTION_SYMBOL] = connectionSymbol;
      const reportError = options?.onError ?? (() => undefined);

      void (async () => {
        const webSocket = await waitForWebSocket(bindings.incoming, connectionSymbol);
        const bufferedMessages: Array<[RawData, boolean]> = [];
        const bufferMessage = (data: RawData, isBinary: boolean) => {
          bufferedMessages.push([data, isBinary]);
        };
        webSocket.on("message", bufferMessage);

        const webSocketContext = new WSContext<WebSocket>({
          raw: webSocket,
          url: context.req.url,
          protocol: webSocket.protocol,
          get readyState() {
            return toReadyState(webSocket.readyState);
          },
          close(code, reason) {
            webSocket.close(code, reason);
          },
          send(source, sendOptions) {
            webSocket.send(source, { compress: sendOptions.compress });
          },
        });

        try {
          events.onOpen?.(new Event("open"), webSocketContext);
        } catch (error) {
          reportError(error);
        }

        const handleMessage = (data: RawData, isBinary: boolean) => {
          try {
            events.onMessage?.(
              new MessageEvent("message", { data: toMessageData(data, isBinary) }),
              webSocketContext,
            );
          } catch (error) {
            reportError(error);
          }
        };

        webSocket.off("message", bufferMessage);
        for (const message of bufferedMessages) {
          handleMessage(...message);
        }
        webSocket.on("message", handleMessage);
        webSocket.on("close", (code, reason) => {
          try {
            events.onClose?.(
              Object.assign(new Event("close"), {
                code,
                reason: reason.toString(),
                wasClean: true,
              }),
              webSocketContext,
            );
          } catch (error) {
            reportError(error);
          }
        });
        webSocket.on("error", (error) => {
          try {
            events.onError?.(Object.assign(new Event("error"), { error }), webSocketContext);
          } catch (handlerError) {
            reportError(handlerError);
          }
        });
      })();

      return new Response();
    },
  );

  return {
    injectWebSocket(server) {
      const httpServer = server as Server;
      httpServer.on("upgrade", async (request, socket, head) => {
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return;
        }

        const host = request.headers.host ?? "localhost";
        const url = new URL(request.url ?? "/", `http://${host}`);
        const bindings: LegacyWebSocketBindings = {
          incoming: request,
          outgoing: undefined,
        };
        let response: Response;
        try {
          response = await app.request(url, { headers: buildRequestHeaders(request) }, bindings);
        } catch {
          rejectUpgrade(socket, 500);
          return;
        }

        const pending = pendingWebSockets.get(request);
        if (!pending || pending.connectionSymbol !== bindings[LEGACY_CONNECTION_SYMBOL]) {
          pendingWebSockets.delete(request);
          rejectUpgrade(socket, response.status);
          return;
        }

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request);
        });
      });
      httpServer.on("close", () => {
        webSocketServer.close();
      });
    },
    upgradeWebSocket,
  };
}
