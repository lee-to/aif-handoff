import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@aif/shared";
import { searchTasksPaginated, toTaskSummary } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";

const log = logger("mcp:tool:search-tasks");
const searchTasksInputSchema: Record<string, z.ZodTypeAny> = {
  query: z.string().min(1).max(200).describe("Search query string (max 200 chars)"),
  projectId: z.string().uuid().optional().describe("Optional project ID to scope the search"),
  executionOwner: z.enum(["ai", "human"]).optional().describe("Filter by execution owner"),
  assigneeId: z.string().uuid().optional().describe("Filter by participant assignee ID"),
  unassigned: z.boolean().optional().describe("Filter tasks without participant assignees"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results per page (default 20, max 50)"),
  offset: z.number().int().min(0).optional().describe("Number of results to skip (default 0)"),
};

type SearchTasksArgs = {
  assigneeId?: string;
  executionOwner?: "ai" | "human";
  limit?: number;
  offset?: number;
  projectId?: string;
  query: string;
  unassigned?: boolean;
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_search_tasks",
    "Full-text search across task title and description with pagination. Returns summary fields.",
    searchTasksInputSchema,
    async (rawArgs) => {
      const args = rawArgs as SearchTasksArgs;
      try {
        if (!context.rateLimiter.check("handoff_search_tasks", "read")) {
          throw rateLimitError("handoff_search_tasks");
        }

        log.debug(
          {
            projectId: args.projectId,
            executionOwner: args.executionOwner,
            assigneeId: args.assigneeId,
            unassigned: args.unassigned,
          },
          "handoff_search_tasks called",
        );

        const result = searchTasksPaginated({
          query: args.query,
          projectId: args.projectId,
          limit: args.limit,
          offset: args.offset,
          executionOwner: args.executionOwner,
          assigneeId: args.assigneeId,
          unassigned: args.unassigned,
        });

        const items = result.items.map((row) => toTaskSummary(row));

        if (items.length === 0) {
          log.warn({ projectId: args.projectId }, "Search returned 0 results");
        }

        log.info(
          {
            resultCount: items.length,
            total: result.total,
            projectId: args.projectId,
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
