import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@aif/shared";
import { searchTasksPaginated, toTaskSummary } from "@aif/data";
import type { ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";

const log = logger("mcp:tool:search-tasks");

export function register(server: McpServer, context: ToolContext): void {
  server.tool(
    "handoff_search_tasks",
    "Full-text search across task title and description with pagination. Returns summary fields.",
    {
      query: z.string().min(1).max(200).describe("Search query string (max 200 chars)"),
      projectId: z.string().uuid().optional().describe("Optional project ID to scope the search"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results per page (default 20, max 50)"),
      offset: z.number().int().min(0).optional().describe("Number of results to skip (default 0)"),
    },
    async (args) => {
      try {
        if (!context.rateLimiter.check("handoff_search_tasks", "read")) {
          throw rateLimitError("handoff_search_tasks");
        }

        log.debug(
          { query: args.query.substring(0, 50), projectId: args.projectId },
          "handoff_search_tasks called",
        );

        const result = searchTasksPaginated({
          query: args.query,
          projectId: args.projectId,
          limit: args.limit,
          offset: args.offset,
        });

        const items = result.items.map(toTaskSummary);

        if (items.length === 0) {
          log.warn(
            { query: args.query.substring(0, 50), projectId: args.projectId },
            "Search returned 0 results",
          );
        }

        log.info(
          {
            resultCount: items.length,
            total: result.total,
            query: args.query.substring(0, 50),
          },
          "handoff_search_tasks completed",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                items,
                total: result.total,
                limit: result.limit,
                offset: result.offset,
              }),
            },
          ],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
