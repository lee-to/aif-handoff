import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@aif/shared";
import { findTaskById, updateTask, toTaskResponse } from "@aif/data";
import type { ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { compactTaskResponse } from "../utils/compactResponse.js";
import { broadcastTaskChange } from "../utils/broadcast.js";
import {
  assertRuntimeProfileSelection,
  buildEffectiveTaskRuntimeMetadata,
} from "./runtimeTaskMetadata.js";

const log = logger("mcp:tool:update-task");

export function register(server: McpServer, context: ToolContext): void {
  server.tool(
    "handoff_update_task",
    "Update an existing task's fields (title, description, status, plan, etc.)",
    {
      taskId: z.string().uuid().describe("Task ID to update (must exist)"),
      title: z.string().max(500).optional().describe("Updated task title"),
      description: z.string().optional().describe("Updated task description"),
      priority: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("Priority level (0=none, 1=low, 2=medium, 3=high)"),
      tags: z.array(z.string()).optional().describe("Updated tags"),
      plan: z.string().nullable().optional().describe("Plan content (null to clear)"),
      autoMode: z.boolean().optional().describe("Enable/disable auto mode"),
      isFix: z.boolean().optional().describe("Mark/unmark as fix"),
      plannerMode: z.enum(["fast", "full"]).optional().describe("Planner mode"),
      planDocs: z.boolean().optional().describe("Include documentation in plan"),
      planTests: z.boolean().optional().describe("Include tests in plan"),
      skipReview: z.boolean().optional().describe("Skip review stage"),
      useSubagents: z.boolean().optional().describe("Use subagents for implementation"),
      maxReviewIterations: z.number().int().min(1).optional().describe("Maximum review iterations"),
      paused: z.boolean().optional().describe("Pause/unpause task"),
      implementationLog: z.string().nullable().optional().describe("Implementation log content"),
      reviewComments: z.string().nullable().optional().describe("Review comments content"),
      roadmapAlias: z.string().nullable().optional().describe("Roadmap milestone alias"),
      blockedReason: z.string().nullable().optional().describe("Reason the task is blocked"),
      runtimeProfileId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe("Optional runtime profile override (must be project-scoped or global)"),
      modelOverride: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Optional model override for task execution"),
      runtimeOptions: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe("Optional runtime-specific options for task execution"),
    },
    async (args) => {
      try {
        if (!context.rateLimiter.check("handoff_update_task", "write")) {
          throw rateLimitError("handoff_update_task");
        }

        log.debug(
          {
            taskId: args.taskId,
            runtimeProfileId: args.runtimeProfileId ?? null,
            modelOverride: args.modelOverride ?? null,
            hasRuntimeOptions: args.runtimeOptions !== undefined,
          },
          "DEBUG [mcp:tool:*] handoff_update_task called with runtime metadata",
        );

        // Validate task exists
        const existing = findTaskById(args.taskId);
        if (!existing) {
          log.error({ taskId: args.taskId }, "Task not found for update");
          throw validationError(`Task not found: ${args.taskId}`, {
            taskId: ["Task does not exist"],
          });
        }

        assertRuntimeProfileSelection({
          toolName: "handoff_update_task",
          projectId: existing.projectId,
          runtimeProfileId: args.runtimeProfileId,
          log,
        });

        // Extract taskId, pass remaining fields to updateTask
        const { taskId, ...fields } = args;

        // Build a summary of changed fields for logging
        const changedFields = Object.keys(fields).filter(
          (key) => fields[key as keyof typeof fields] !== undefined,
        );

        const row = updateTask(taskId, fields);

        if (!row) {
          log.error({ taskId }, "Task update returned undefined");
          throw validationError(`Task not found after update: ${taskId}`, {
            taskId: ["Task disappeared during update"],
          });
        }

        const full = toTaskResponse(row);
        const effectiveRuntime = buildEffectiveTaskRuntimeMetadata(full.id, full.projectId);
        const compact = compactTaskResponse({ ...full, effectiveRuntime });

        log.debug(
          {
            taskId,
            effectiveRuntimeSource: effectiveRuntime.source,
            effectiveRuntimeProfileId: effectiveRuntime.profileId,
          },
          "DEBUG [mcp:tool:*] Returning compact task response with effective runtime metadata",
        );

        log.info(
          {
            taskId,
            changedFields,
            runtimeProfileId: args.runtimeProfileId ?? null,
            modelOverride: args.modelOverride ?? null,
          },
          "handoff_update_task completed",
        );

        void broadcastTaskChange(taskId);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(compact) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
