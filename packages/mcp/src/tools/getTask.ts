import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@aif/shared";
import { findTaskById, toTaskResponse } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";
import { buildEffectiveTaskRuntimeMetadata } from "./runtimeTaskMetadata.js";

const log = logger("mcp:tool:get-task");

/** All known Task field names for validation */
const TASK_FIELDS = [
  "id",
  "projectId",
  "title",
  "description",
  "attachments",
  "autoMode",
  "isFix",
  "plannerMode",
  "planPath",
  "planDocs",
  "planTests",
  "skipReview",
  "useSubagents",
  "status",
  "priority",
  "position",
  "plan",
  "implementationLog",
  "reviewComments",
  "agentActivityLog",
  "blockedReason",
  "blockedFromStatus",
  "retryAfter",
  "retryCount",
  "tokenInput",
  "tokenOutput",
  "tokenTotal",
  "costUsd",
  "roadmapAlias",
  "tags",
  "reworkRequested",
  "reviewIterationCount",
  "maxReviewIterations",
  "manualReviewRequired",
  "autoReviewState",
  "paused",
  "lastHeartbeatAt",
  "lastSyncedAt",
  "runtimeProfileId",
  "modelOverride",
  "runtimeOptions",
  "effectiveRuntime",
  "sessionId",
  "createdAt",
  "updatedAt",
] as const;
const getTaskInputSchema: Record<string, z.ZodTypeAny> = {
  taskId: z.string().uuid().describe("Task ID to retrieve"),
  fields: z
    .array(z.enum(TASK_FIELDS))
    .optional()
    .describe(
      "Optional list of field names to return. Omit for all fields. 'id' is always included.",
    ),
};

type GetTaskArgs = {
  fields?: (typeof TASK_FIELDS)[number][];
  taskId: string;
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_get_task",
    "Get a single task by ID. Pass 'fields' to select specific fields (always includes 'id'); omit for full detail.",
    getTaskInputSchema,
    async (rawArgs) => {
      const args = rawArgs as GetTaskArgs;
      try {
        if (!context.rateLimiter.check("handoff_get_task", "read")) {
          throw rateLimitError("handoff_get_task");
        }

        log.debug({ taskId: args.taskId, fields: args.fields }, "handoff_get_task called");

        const row = findTaskById(args.taskId);

        if (!row) {
          log.warn({ taskId: args.taskId }, "Task not found");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Task not found", taskId: args.taskId }),
              },
            ],
            isError: true,
          };
        }

        const full = {
          ...toTaskResponse(row),
          effectiveRuntime: buildEffectiveTaskRuntimeMetadata(row.id, row.projectId),
        } as unknown as Record<string, unknown>;

        let result: Record<string, unknown>;
        if (args.fields && args.fields.length > 0) {
          const requested = new Set<string>(args.fields);
          requested.add("id");
          result = {};
          for (const key of requested) {
            if (key in full) {
              result[key] = full[key];
            }
          }
        } else {
          result = full;
        }

        log.info(
          { taskId: args.taskId, fieldCount: Object.keys(result).length },
          "handoff_get_task completed",
        );

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
