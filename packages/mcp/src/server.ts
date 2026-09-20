import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "@aif/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpEnv } from "./env.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import type { ToolContext } from "./tools/index.js";
import { register as registerListTasks } from "./tools/listTasks.js";
import { register as registerGetTask } from "./tools/getTask.js";
import { register as registerSearchTasks } from "./tools/searchTasks.js";
import { register as registerListProjects } from "./tools/listProjects.js";
import { register as registerCreateTask } from "./tools/createTask.js";
import { register as registerUpdateTask } from "./tools/updateTask.js";
import { register as registerSyncStatus } from "./tools/syncStatus.js";
import { register as registerPushPlan } from "./tools/pushPlan.js";
import { register as registerAnnotatePlan } from "./tools/annotatePlan.js";

const log = logger("mcp");

/**
 * Build the shared tool context (rate limiter) once at startup.
 *
 * In HTTP mode a fresh {@link McpServer} is created per request, but every
 * request MUST share this context: the {@link RateLimiter} keeps stateful
 * in-memory token buckets, so rebuilding it per request would reset the buckets
 * and silently disable rate limiting.
 */
export function createToolContext(env: McpEnv): ToolContext {
  const rateLimiter = new RateLimiter(
    { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
    { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
  );

  log.debug(
    {
      read: { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
      write: { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
    },
    "Shared tool context created",
  );

  return { rateLimiter };
}

/**
 * Create an {@link McpServer} and register all tools against the shared context.
 * Cheap to call — safe to invoke per request in stateless HTTP mode.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "handoff-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register read-only tools
  registerListTasks(server, context);
  registerGetTask(server, context);
  registerSearchTasks(server, context);
  registerListProjects(server, context);

  // Register write tools
  registerCreateTask(server, context);
  registerUpdateTask(server, context);
  registerSyncStatus(server, context);
  registerPushPlan(server, context);
  registerAnnotatePlan(server, context);

  return server;
}

type McpDispatcher = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
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

/**
 * Build the Node HTTP request handler. Exposed (with the factories above) for
 * tests so routing + transport wiring can be exercised without binding a port
 * or importing the process entry (`index.ts` self-runs `main()` on import).
 *
 * Routing (`/health`, `/mcp`, 404) is shared; the `/mcp` behavior is selected
 * ONCE, at handler-build time, by `env.httpMultiSession`:
 *  - `true`  → stateless per-request server/transport (multiple clients connect
 *              concurrently — see {@link createStatelessMcpDispatcher}).
 *  - `false` → legacy single shared stateful transport, preserving the previous
 *              behavior (see {@link createSingleSessionMcpDispatcher}).
 */
export function createMcpHttpHandler(env: McpEnv, context: ToolContext) {
  const handleMcp = env.httpMultiSession
    ? createStatelessMcpDispatcher(context)
    : createSingleSessionMcpDispatcher(context);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://localhost:${env.httpPort}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/mcp") {
      const token = bearerToken(
        Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization,
      );
      if (!env.authToken || !tokensMatch(token, env.authToken)) {
        log.warn(
          { method: req.method, path: url.pathname },
          "Rejected unauthorized MCP HTTP request",
        );
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(
          JSON.stringify({
            error: "Unauthorized",
            code: "mcp_authentication_required",
          }),
        );
        return;
      }
      log.debug({ method: req.method, path: url.pathname }, "Authorized MCP HTTP request");
      await handleMcp(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };
}

/**
 * Multi-session transport (opt-in via `AIF_MCP_HTTP_MULTI_SESSION_ENABLED`).
 *
 * A {@link StreamableHTTPServerTransport} with no `sessionIdGenerator` handles
 * exactly ONE request, so a fresh server + transport is created per POST. This
 * lets every client (each Claude Code window) initialize independently instead
 * of colliding on a single shared stateful session (which returned -32600
 * "Server already initialized" for the 2nd client). Server->client events do not
 * travel through this transport — they are pushed via the API broadcast
 * endpoint — so no session tracking is needed.
 *
 * The stateless path is request/response only: it accepts `POST` and rejects
 * other methods with `405`. The SDK client opens an optional `GET /mcp` SSE
 * stream after initialization and treats `405` as "server does not offer SSE";
 * refusing it avoids holding an idle server/transport open per connected client
 * for events we never push through this transport.
 */
function createStatelessMcpDispatcher(context: ToolContext): McpDispatcher {
  return async (req, res) => {
    log.debug({ method: req.method, mode: "multi-session" }, "MCP request received");

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    const server = createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      log.debug("MCP request closed — tearing down per-request server/transport");
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "MCP request handling failed",
      );
      respondInternalError(res);
    }
  };
}

/**
 * Legacy single-session transport (default, off-by-default flag).
 *
 * ONE server + ONE stateful transport shared across the whole process, connected
 * once (lazily) on the first request. This preserves the pre-multi-session
 * behavior: a second client's `initialize` still returns -32600 "Server already
 * initialized". Kept behind `AIF_MCP_HTTP_MULTI_SESSION_ENABLED` so enabling
 * concurrent clients is an explicit, intentional rollout rather than an
 * unconditional change to the external MCP transport contract.
 */
function createSingleSessionMcpDispatcher(context: ToolContext): McpDispatcher {
  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  let connected: Promise<void> | null = null;

  return async (req, res) => {
    log.debug({ method: req.method, mode: "single-session" }, "MCP request received");
    try {
      connected ??= server.connect(transport);
      await connected;
      await transport.handleRequest(req, res);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "MCP request handling failed",
      );
      respondInternalError(res);
    }
  };
}

/** Send a JSON-RPC internal-error response unless headers were already sent. */
function respondInternalError(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    }),
  );
}

export { loadMcpEnv } from "./env.js";
export { RateLimiter } from "./middleware/rateLimit.js";
export { toMcpError, rateLimitError, validationError } from "./middleware/errorHandler.js";
export type { ToolContext, ToolRegistrar } from "./tools/index.js";
