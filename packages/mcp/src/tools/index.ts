import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { RateLimiter } from "../middleware/rateLimit.js";

export interface ToolContext {
  rateLimiter: RateLimiter;
}

type LooseToolCallback = (args: unknown) => Promise<unknown> | unknown;

export function registerMcpTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, ZodTypeAny> | ZodTypeAny | undefined,
  callback: LooseToolCallback,
): void {
  const unsafeServer = server as unknown as {
    registerTool?: (
      name: string,
      config: { description?: string; inputSchema?: unknown },
      callback: LooseToolCallback,
    ) => unknown;
    tool?: (
      name: string,
      description: string,
      inputSchemaOrCallback: unknown,
      callback?: LooseToolCallback,
    ) => unknown;
  };

  if (typeof unsafeServer.registerTool === "function") {
    unsafeServer.registerTool(name, { description, inputSchema }, callback);
    return;
  }

  if (typeof unsafeServer.tool === "function") {
    if (inputSchema === undefined) {
      unsafeServer.tool(name, description, callback);
      return;
    }

    unsafeServer.tool(name, description, inputSchema, callback);
    return;
  }

  throw new TypeError("MCP server does not expose registerTool() or tool()");
}

/**
 * Tool registration helper. Each tool module exports a `register` function
 * that takes the MCP server and context to register its tool.
 */
export type ToolRegistrar = (server: McpServer, context: ToolContext) => void;
