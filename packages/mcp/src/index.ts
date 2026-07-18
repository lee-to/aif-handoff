// stdioEnv MUST be imported first — it forces logs to stderr before the
// @aif/shared logger initialises, keeping stdout clean for stdio JSON-RPC.
import "./stdioEnv.js";
import { createServer } from "node:http";
import { logger } from "@aif/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpEnv } from "./env.js";
import type { McpEnv } from "./env.js";
import { createToolContext, createMcpServer, createMcpHttpHandler } from "./server.js";

const log = logger("mcp");

async function startStdio(env: McpEnv) {
  const context = createToolContext(env);
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server connected via stdio transport");
}

async function startHttp(env: McpEnv) {
  const context = createToolContext(env);
  const httpServer = createServer(createMcpHttpHandler(env, context));

  httpServer.listen(env.httpPort, () => {
    log.info(
      { port: env.httpPort, endpoint: "/mcp" },
      "MCP server listening via Streamable HTTP transport",
    );
  });

  // Graceful shutdown so the port is freed on Ctrl+C / tsx-watch reload.
  // Exit synchronously — tsx watch + turbo race on Ctrl+C and complain
  // about "Previous process hasn't exited yet" when close is async.
  let shuttingDown = false;
  const onShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutdown signal received — exiting");
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => onShutdown("SIGINT"));
  process.on("SIGTERM", () => onShutdown("SIGTERM"));
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

// Public surface for consumers of the @aif/mcp package.
export { loadMcpEnv, RateLimiter, toMcpError, rateLimitError, validationError } from "./server.js";
export type { ToolContext, ToolRegistrar } from "./server.js";
