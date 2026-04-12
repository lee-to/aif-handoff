import "./stdioEnv.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { logger } from "@aif/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadMcpEnv } from "./env.js";
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

function createMcpServer(env: ReturnType<typeof loadMcpEnv>): McpServer {
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

  const rateLimiter = new RateLimiter(
    { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
    { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
  );

  const context: ToolContext = { rateLimiter };

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

async function startStdio(env: ReturnType<typeof loadMcpEnv>) {
  const server = createMcpServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server connected via stdio transport");
}

async function startHttp(env: ReturnType<typeof loadMcpEnv>) {
  const server = createMcpServer(env);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${env.httpPort}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/mcp") {
      transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(env.httpPort, () => {
    log.info(
      { port: env.httpPort, endpoint: "/mcp" },
      "MCP server listening via Streamable HTTP transport",
    );
  });
}

async function main() {
  const env = loadMcpEnv();

  log.info(
    {
      transport: env.transport,
      httpPort: env.httpPort,
    },
    "MCP server starting",
  );

  if (env.transport === "http") {
    await startHttp(env);
  } else {
    await startStdio(env);
  }
}

main().catch((error) => {
  log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "MCP server failed to start",
  );
  process.exit(1);
});

export { loadMcpEnv } from "./env.js";
export { RateLimiter } from "./middleware/rateLimit.js";
export { toMcpError, rateLimitError, validationError } from "./middleware/errorHandler.js";
export type { ToolContext, ToolRegistrar } from "./tools/index.js";
