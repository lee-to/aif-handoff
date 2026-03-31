import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, TASK_STATUSES } from "@aif/shared";
import { findTaskById, updateTaskStatus, touchLastSyncedAt, toTaskResponse } from "@aif/data";
import type { ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { resolveConflict } from "../sync/conflictResolver.js";
import { compactTaskResponse } from "../utils/compactResponse.js";

const log = logger("mcp:tool:sync-status");

export function register(server: McpServer, context: ToolContext): void {
  server.tool(
    "handoff_sync_status",
    "Bidirectional status sync with conflict detection and resolution",
    {
      taskId: z.string().uuid().describe("Task ID to sync status for"),
      newStatus: z.enum(TASK_STATUSES).describe("New status to set"),
      sourceTimestamp: z
        .string()
        .describe("ISO timestamp with millisecond precision from the source system"),
      direction: z.enum(["aif_to_handoff", "handoff_to_aif"]).describe("Sync direction"),
    },
    async (args) => {
      try {
        if (!context.rateLimiter.check("handoff_sync_status", "write")) {
          throw rateLimitError("handoff_sync_status");
        }

        log.debug({ args }, "handoff_sync_status called");

        const row = findTaskById(args.taskId);
        if (!row) {
          throw validationError(`Task not found: ${args.taskId}`, {
            taskId: ["Task does not exist"],
          });
        }

        // If status is already the same, no-op
        if (row.status === args.newStatus) {
          log.info(
            { taskId: args.taskId, status: args.newStatus, direction: args.direction },
            "Status already matches, no change needed",
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  applied: false,
                  conflict: false,
                  task: compactTaskResponse(toTaskResponse(row)),
                  lastSyncedAt: row.lastSyncedAt,
                }),
              },
            ],
          };
        }

        // Resolve conflict using last-write-wins
        const resolution = resolveConflict({
          sourceTimestamp: args.sourceTimestamp,
          targetTimestamp: row.updatedAt,
          field: "status",
        });

        if (resolution.conflict) {
          // Target is newer — return conflict info without modifying
          log.warn(
            {
              taskId: args.taskId,
              direction: args.direction,
              currentStatus: row.status,
              requestedStatus: args.newStatus,
              sourceTimestamp: args.sourceTimestamp,
              targetTimestamp: row.updatedAt,
            },
            "Status sync conflict detected",
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  applied: false,
                  conflict: true,
                  conflictResolution: resolution,
                  task: compactTaskResponse(toTaskResponse(row)),
                  lastSyncedAt: row.lastSyncedAt,
                }),
              },
            ],
          };
        }

        // Source is newer — apply the status change
        updateTaskStatus(args.taskId, args.newStatus);
        touchLastSyncedAt(args.taskId);

        const updatedRow = findTaskById(args.taskId);
        const task = updatedRow ? toTaskResponse(updatedRow) : toTaskResponse(row);

        log.info(
          {
            taskId: args.taskId,
            direction: args.direction,
            oldStatus: row.status,
            newStatus: args.newStatus,
          },
          "Status sync applied",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                applied: true,
                conflict: false,
                conflictResolution: resolution,
                task: compactTaskResponse(task),
                lastSyncedAt: updatedRow?.lastSyncedAt ?? null,
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
