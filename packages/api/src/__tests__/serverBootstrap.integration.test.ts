import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  broadcast,
  closeAllWebSocketClients,
  getConnectedWebSocketClientCount,
  sendToClient,
  setupWebSocket,
} from "../ws.js";
import { startServer } from "../serverBootstrap.js";

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

function waitForMessage(webSocket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      webSocket.off("error", onError);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      webSocket.off("message", onMessage);
      reject(error);
    };
    webSocket.once("message", onMessage);
    webSocket.once("error", onError);
  });
}

describe("startServer WebSocket integration", () => {
  afterEach(() => {
    closeAllWebSocketClients();
  });

  it.each([
    { nodeServerV2Enabled: false, strategy: "legacy" },
    { nodeServerV2Enabled: true, strategy: "node-server-v2" },
  ])(
    "completes the real $strategy handshake and client lifecycle",
    async ({ nodeServerV2Enabled }) => {
      const app = new Hono();
      const webSocketSetup = setupWebSocket(app, nodeServerV2Enabled);
      let ready: (() => void) | null = null;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const server = startServer({
        fetch: app.fetch,
        port: 0,
        hostname: "127.0.0.1",
        ...webSocketSetup,
        onStarted() {
          ready?.();
        },
        logger: createLogger(),
      });

      await started;
      const address = server.address() as AddressInfo;
      const webSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

      try {
        const connectedMessage = waitForMessage(webSocket);
        await new Promise<void>((resolve, reject) => {
          webSocket.once("open", resolve);
          webSocket.once("error", reject);
        });
        const connected = await connectedMessage;
        expect(connected.type).toBe("ws:connected");
        const clientId = (connected.payload as { clientId: string }).clientId;

        const directedMessage = waitForMessage(webSocket);
        expect(
          sendToClient(clientId, {
            type: "task:updated",
            payload: { id: "directed" },
          }),
        ).toBe(true);
        expect(await directedMessage).toEqual({
          type: "task:updated",
          payload: { id: "directed" },
        });

        const broadcastMessage = waitForMessage(webSocket);
        broadcast({
          type: "task:updated",
          payload: { id: "broadcast" },
        });
        expect(await broadcastMessage).toEqual({
          type: "task:updated",
          payload: { id: "broadcast" },
        });

        const closed = new Promise<void>((resolve) => {
          webSocket.once("close", () => resolve());
        });
        webSocket.close();
        await closed;
        await vi.waitFor(() => {
          expect(getConnectedWebSocketClientCount()).toBe(0);
          expect(
            sendToClient(clientId, {
              type: "task:updated",
              payload: { id: "after-close" },
            }),
          ).toBe(false);
        });
      } finally {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.close();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  );
});
