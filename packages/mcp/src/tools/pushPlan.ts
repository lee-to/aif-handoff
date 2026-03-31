import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, parsePlanAnnotations } from "@aif/shared";
import { findTaskById, setTaskFields, toTaskResponse } from "@aif/data";
import type { ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { compactTaskResponse } from "../utils/compactResponse.js";

const log = logger("mcp:tool:push-plan");

export function register(server: McpServer, context: ToolContext): void {
  server.tool(
    "handoff_push_plan",
    "Push plan content to a task's plan field with annotation preservation",
    {
      taskId: z.string().uuid().describe("Task ID to push plan to"),
      planContent: z.string().max(100_000).describe("Plan content in markdown (max 100KB)"),
    },
    async (args) => {
      try {
        if (!context.rateLimiter.check("handoff_push_plan", "write")) {
          throw rateLimitError("handoff_push_plan");
        }

        log.debug(
          { taskId: args.taskId, planSize: args.planContent.length },
          "handoff_push_plan called",
        );

        const row = findTaskById(args.taskId);
        if (!row) {
          throw validationError(`Task not found: ${args.taskId}`, {
            taskId: ["Task does not exist"],
          });
        }

        // Parse annotations from the incoming plan
        const annotations = parsePlanAnnotations(args.planContent);
        log.debug(
          { taskId: args.taskId, annotationCount: annotations.length },
          "Parsed annotations",
        );

        // Validate referenced task IDs exist
        const annotationResults = annotations.map((ann) => {
          const referencedTask = findTaskById(ann.taskId);
          if (!referencedTask) {
            log.warn(
              { taskId: args.taskId, referencedTaskId: ann.taskId, line: ann.line },
              "Plan references non-existent task",
            );
          }
          return {
            taskId: ann.taskId,
            line: ann.line,
            valid: !!referencedTask,
          };
        });

        // Update the task's plan field
        setTaskFields(args.taskId, { plan: args.planContent, updatedAt: new Date().toISOString() });
        const updatedRow = findTaskById(args.taskId);
        const task = updatedRow ? toTaskResponse(updatedRow) : toTaskResponse(row);

        log.info(
          {
            taskId: args.taskId,
            planSize: args.planContent.length,
            annotationCount: annotations.length,
          },
          "handoff_push_plan completed",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                task: compactTaskResponse(task),
                annotations: annotationResults,
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
