import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb } from "@aif/shared/server";

// Set up an in-memory test DB before importing the server (tools reach the DB
// through @aif/data → @aif/shared/server getDb).
const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Mock env to avoid shared env validation.
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

// Import the handler from server.ts — NOT index.ts, which self-runs main().
const { createMcpHttpHandler, createToolContext } = await import("../server.js");

const env = {
  apiUrl: "http://localhost:3009",
  transport: "http" as const,
  httpPort: 0,
  rateLimitReadRpm: 120,
  rateLimitWriteRpm: 30,
  rateLimitReadBurst: 10,
  rateLimitWriteBurst: 5,
  // Exercise the opt-in stateless multi-session path in the main suite.
  httpMultiSession: true,
  participantsModeEnabled: false,
  authToken: "dedicated-mcp-token",
};

/** POST an arbitrary JSON-RPC message with the headers the SDK requires (else 406). */
function postRpc(
  port: number,
  body: Record<string, unknown>,
  authToken: string | null = env.authToken,
): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The SDK returns 406 unless the client accepts BOTH content types.
      Accept: "application/json, text/event-stream",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** POST a JSON-RPC `initialize` request. */
function initialize(port: number, authToken: string | null = env.authToken): Promise<Response> {
  return postRpc(
    port,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    },
    authToken,
  );
}

/** Read a JSON-RPC payload from either a JSON or an SSE (`data:`) response. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
    }
  }
  return null;
}

describe("MCP HTTP transport — multi-session (opt-in)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(env);
    server = createServer(createMcpHttpHandler(env, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /health for Docker healthchecks", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("requires a bearer token even when Participants Mode is disabled", async () => {
    const response = await initialize(port, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "mcp_authentication_required" });
  });

  it("lets two independent clients initialize without -32600", async () => {
    // The core regression: with a single shared stateful transport the second
    // initialize returned -32600 "Server already initialized". Stateless
    // per-request transports let every client initialize independently.
    const res1 = await initialize(port);
    const body1 = await readJsonRpc(res1);
    const res2 = await initialize(port);
    const body2 = await readJsonRpc(res2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((body1?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect((body2?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect(body1?.result).toBeDefined();
    expect(body2?.result).toBeDefined();
  });

  it("lets a client initialize then list tools through the stateless path", async () => {
    // Proves real MCP usage works, not just the initialize handshake: a
    // transport change that fixed init but broke tools/list would be caught
    // here. Stateless per-request transports do not gate tools/list behind a
    // prior initialize on the same connection, so a fresh POST lists tools.
    const initRes = await initialize(port);
    expect(initRes.status).toBe(200);
    await readJsonRpc(initRes);

    const listRes = await postRpc(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listBody = await readJsonRpc(listRes);

    expect(listRes.status).toBe(200);
    expect(listBody?.error).toBeUndefined();
    const tools = (listBody?.result as { tools?: unknown[] } | undefined)?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as unknown[]).length).toBeGreaterThan(0);
  });

  it("rejects non-POST /mcp with 405 instead of opening an idle SSE stream", async () => {
    // The SDK client opens an optional GET SSE stream after init and treats 405
    // as "no server SSE". Since events are pushed out-of-band via the API
    // broadcast endpoint, accepting GET would hold an idle server/transport per
    // client for no benefit — so the stateless path is POST-only.
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${env.authToken}`,
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    await res.text();
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("createToolContext builds one stateful, shared RateLimiter", () => {
    // The handler closes over a single context, so every per-request server
    // shares this limiter. If it were rebuilt per request the bucket would
    // reset and rate limiting would silently break — so assert the bucket
    // accumulates state across calls.
    const context = createToolContext(env);
    for (let i = 0; i < env.rateLimitReadBurst; i++) {
      expect(context.rateLimiter.check("listTasks", "read")).toBe(true);
    }
    expect(context.rateLimiter.check("listTasks", "read")).toBe(false);
  });
});

describe("MCP HTTP transport — Participants Mode bearer auth", () => {
  const protectedEnv = {
    ...env,
    participantsModeEnabled: true,
    authToken: "dedicated-mcp-token",
  };
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(protectedEnv);
    server = createServer(createMcpHttpHandler(protectedEnv, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps health public but rejects missing and invalid MCP bearer tokens", async () => {
    expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);

    const missing = await initialize(port, null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      code: "mcp_authentication_required",
    });
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const invalid = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(invalid.status).toBe(401);
  });

  it("accepts the exact dedicated MCP bearer token", async () => {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer dedicated-mcp-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect((await readJsonRpc(response))?.result).toBeDefined();
  });
});

describe("MCP HTTP transport — legacy single-session (default, flag off)", () => {
  const legacyEnv = { ...env, httpMultiSession: false };
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(legacyEnv);
    server = createServer(createMcpHttpHandler(legacyEnv, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("preserves previous behavior: the 2nd client initialize collides with -32600", async () => {
    // With the flag off, one shared stateful transport is reused across the
    // process. The first client initializes, the second collides — the exact
    // pre-fix behavior that AIF_MCP_HTTP_MULTI_SESSION_ENABLED gates.
    const res1 = await initialize(port);
    const body1 = await readJsonRpc(res1);
    expect(res1.status).toBe(200);
    expect(body1?.result).toBeDefined();

    const res2 = await initialize(port);
    const body2 = await readJsonRpc(res2);
    expect((body2?.error as { code?: number } | undefined)?.code).toBe(-32600);
  });
});
