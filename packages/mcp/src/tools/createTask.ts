import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@aif/shared";
import { createTask, findProjectById, toTaskResponse } from "@aif/data";
import type { ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { compactTaskResponse } from "../utils/compactResponse.js";

const log = logger("mcp:tool:create-task");

export function register(server: McpServer, context: ToolContext): void {
  server.tool(
    "handoff_create_task",
    "Create a new task in Handoff with all standard fields",
    {
      projectId: z.string().uuid().describe("Project ID the task belongs to (must exist)"),
      title: z.string().min(1).max(500).describe("Task title"),
      description: z.string().optional().describe("Task description"),
      priority: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("Priority level (0=none, 1=low, 2=medium, 3=high)"),
      tags: z.array(z.string()).optional().describe("Tags for the task"),
      plannerMode: z.enum(["fast", "full"]).optional().describe("Planner mode"),
      autoMode: z.boolean().optional().describe("Enable auto mode for agent processing"),
      isFix: z.boolean().optional().describe("Mark task as a fix"),
      planDocs: z.boolean().optional().describe("Include documentation in plan"),
      planTests: z.boolean().optional().describe("Include tests in plan"),
      skipReview: z.boolean().optional().describe("Skip review stage"),
      useSubagents: z.boolean().optional().describe("Use subagents for implementation"),
      maxReviewIterations: z.number().int().min(1).optional().describe("Maximum review iterations"),
      paused: z.boolean().optional().describe("Create task in paused state"),
    },
    async (args) => {
      try {
        if (!context.rateLimiter.check("handoff_create_task", "write")) {
          throw rateLimitError("handoff_create_task");
        }

        log.debug({ args }, "handoff_create_task called");

        // Validate project exists
        const project = findProjectById(args.projectId);
        if (!project) {
          log.error({ projectId: args.projectId }, "Project not found for task creation");
          throw validationError(`Project not found: ${args.projectId}`, {
            projectId: ["Project does not exist"],
          });
        }

        const row = createTask({
          projectId: args.projectId,
          title: args.title,
          description: args.description ?? "",
          priority: args.priority,
          tags: args.tags,
          plannerMode: args.plannerMode,
          autoMode: args.autoMode,
          isFix: args.isFix,
          planDocs: args.planDocs,
          planTests: args.planTests,
          skipReview: args.skipReview,
          useSubagents: args.useSubagents,
          maxReviewIterations: args.maxReviewIterations,
          paused: args.paused,
        });

        if (!row) {
          log.error(
            { projectId: args.projectId, title: args.title },
            "Task creation returned undefined",
          );
          throw new McpError(ErrorCode.InternalError, "Failed to create task");
        }

        const full = toTaskResponse(row);

        log.info(
          { taskId: full.id, projectId: args.projectId, title: args.title },
          "handoff_create_task completed",
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(compactTaskResponse(full)) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
