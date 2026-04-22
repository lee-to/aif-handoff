import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "@aif/shared";
import { listProjects } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";

const log = logger("mcp:tool:list-projects");

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_list_projects",
    "List all available projects",
    undefined,
    async () => {
      try {
        if (!context.rateLimiter.check("handoff_list_projects", "read")) {
          throw rateLimitError("handoff_list_projects");
        }

        log.debug("handoff_list_projects called");

        const results = listProjects();

        log.info({ resultCount: results.length }, "handoff_list_projects completed");

        return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
