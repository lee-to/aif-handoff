import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const ORIGIN = "http://127.0.0.1:5180";
const COOKIE_NAME = "test_participant_session";

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  const defaults = actual.validateEnv({});
  return {
    ...actual,
    getEnv: () => ({
      ...defaults,
      PARTICIPANTS_MODE_ENABLED: true,
      PARTICIPANT_SESSION_COOKIE_NAME: COOKIE_NAME,
      PARTICIPANT_ALLOWED_ORIGINS: [ORIGIN],
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

const { createParticipant, createParticipantSession, revokeParticipantSession } =
  await import("@aif/data");
const { broadcast, closeAllWebSocketClients, getConnectedWebSocketClientCount, setupWebSocket } =
  await import("../ws.js");
const { startServer } = await import("../serverBootstrap.js");

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

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

beforeEach(() => {
  testDb.current = createTestDb();
});

afterEach(() => {
  closeAllWebSocketClients();
});

describe("Participants Mode WebSocket authentication", () => {
  it.each([
    { nodeServerV2Enabled: false, strategy: "legacy" },
    { nodeServerV2Enabled: true, strategy: "node-server-v2" },
  ])(
    "authenticates and revokes only the target sessions over the real $strategy transport",
    async ({ nodeServerV2Enabled }) => {
      const participant = await createParticipant({
        username: `ws-${nodeServerV2Enabled ? "v2" : "legacy"}`,
        displayName: "WebSocket Participant",
        password: "a sufficiently safe password",
      });
      expect(participant.ok).toBe(true);
      if (!participant.ok) return;
      const observer = await createParticipant({
        username: `ws-observer-${nodeServerV2Enabled ? "v2" : "legacy"}`,
        displayName: "WebSocket Observer",
        password: "another sufficiently safe password",
      });
      expect(observer.ok).toBe(true);
      if (!observer.ok) return;
      const session = createParticipantSession(participant.participant.id, {
        ttlMs: 60_000,
      });
      const observerSession = createParticipantSession(observer.participant.id, {
        ttlMs: 60_000,
      });
      const expiredSession = createParticipantSession(participant.participant.id, {
        ttlMs: 1_000,
        now: new Date(Date.now() - 2_000),
      });
      expect(session).not.toBeNull();
      expect(observerSession).not.toBeNull();
      expect(expiredSession).not.toBeNull();
      if (!session || !observerSession || !expiredSession) return;

      const app = new Hono();
      const setup = setupWebSocket(app, nodeServerV2Enabled);
      let ready: (() => void) | null = null;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const server = startServer({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        ...setup,
        onStarted() {
          ready?.();
        },
        logger: createLogger(),
      });
      await started;
      const address = server.address() as AddressInfo;
      const httpUrl = `http://127.0.0.1:${address.port}/ws`;
      const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

      try {
        const unauthenticated = await fetch(httpUrl, {
          headers: { origin: ORIGIN },
        });
        expect(unauthenticated.status).toBe(401);
        expect(await unauthenticated.json()).toMatchObject({
          code: "authentication_required",
        });

        const invalidOrigin = await fetch(httpUrl, {
          headers: {
            cookie: `${COOKIE_NAME}=${session.token}`,
            origin: "http://attacker.invalid",
          },
        });
        expect(invalidOrigin.status).toBe(403);
        expect(await invalidOrigin.json()).toMatchObject({ code: "invalid_origin" });

        const expired = await fetch(httpUrl, {
          headers: {
            cookie: `${COOKIE_NAME}=${expiredSession.token}`,
            origin: ORIGIN,
          },
        });
        expect(expired.status).toBe(401);

        const webSocket = new WebSocket(wsUrl, {
          headers: {
            cookie: `${COOKIE_NAME}=${session.token}`,
            origin: ORIGIN,
          },
        });
        const connectedMessage = waitForMessage(webSocket);
        await new Promise<void>((resolve, reject) => {
          webSocket.once("open", resolve);
          webSocket.once("error", reject);
        });
        expect(await connectedMessage).toMatchObject({
          type: "ws:connected",
          payload: {
            clientId: expect.any(String),
            participantId: participant.participant.id,
          },
        });

        const observerWebSocket = new WebSocket(wsUrl, {
          headers: {
            cookie: `${COOKIE_NAME}=${observerSession.token}`,
            origin: ORIGIN,
          },
        });
        const observerConnectedMessage = waitForMessage(observerWebSocket);
        await new Promise<void>((resolve, reject) => {
          observerWebSocket.once("open", resolve);
          observerWebSocket.once("error", reject);
        });
        expect(await observerConnectedMessage).toMatchObject({
          type: "ws:connected",
          payload: {
            clientId: expect.any(String),
            participantId: observer.participant.id,
          },
        });
        expect(getConnectedWebSocketClientCount()).toBe(2);

        const observerMessage = vi.fn();
        observerWebSocket.on("message", observerMessage);

        const closed = new Promise<void>((resolve) => {
          webSocket.once("close", () => resolve());
        });
        expect(revokeParticipantSession(session.token)).toBe(true);
        broadcast({
          type: "auth:session_revoked",
          payload: { participantId: participant.participant.id },
        });
        await closed;
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(observerWebSocket.readyState).toBe(WebSocket.OPEN);
        expect(observerMessage).not.toHaveBeenCalled();
        expect(getConnectedWebSocketClientCount()).toBe(1);
      } finally {
        closeAllWebSocketClients();
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
