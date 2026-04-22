import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, TASK_STATUSES } from "@aif/shared";
import { listTasksPaginated, toTaskSummary } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";

const log = logger("mcp:tool:list-tasks");
const listTasksInputSchema = z.object({
  projectId: z.string().uuid().optional().describe("Filter by project ID"),
  status: z.enum(TASK_STATUSES).optional().describe("Filter by task status"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results per page (default 20, max 100)"),
  offset: z.number().int().min(0).optional().describe("Number of results to skip (default 0)"),
});

type ListTasksArgs = {
  limit?: number;
  offset?: number;
  projectId?: string;
  status?: (typeof TASK_STATUSES)[number];
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_list_tasks",
    "List tasks with optional filters and pagination. Returns summary fields (no plan/logs).",
    listTasksInputSchema,
    async (rawArgs) => {
      const args = rawArgs as ListTasksArgs;
      try {
        if (!context.rateLimiter.check("handoff_list_tasks", "read")) {
          throw rateLimitError("handoff_list_tasks");
        }

        log.debug({ ...args }, "handoff_list_tasks called");

        const result = listTasksPaginated({
          projectId: args.projectId,
          status: args.status,
          limit: args.limit,
          offset: args.offset,
        });

        const items = result.items.map(toTaskSummary);

        log.info(
          {
            resultCount: items.length,
            total: result.total,
            limit: result.limit,
            offset: result.offset,
            projectId: args.projectId,
            status: args.status,
          },
          "handoff_list_tasks completed",
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
