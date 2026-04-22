import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, insertPlanAnnotation, parsePlanAnnotations } from "@aif/shared";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError } from "../middleware/errorHandler.js";

const log = logger("mcp:tool:annotate-plan");
const annotatePlanInputSchema: Record<string, z.ZodTypeAny> = {
  taskId: z.string().uuid().describe("Task ID to annotate"),
  planContent: z.string().max(100_000).describe("Plan content in markdown (max 100KB)"),
  sectionHeading: z
    .string()
    .max(200)
    .optional()
    .describe("Section heading to insert annotation after"),
};

type AnnotatePlanArgs = {
  planContent: string;
  sectionHeading?: string;
  taskId: string;
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_annotate_plan",
    "Insert or update task ID annotations in plan markdown",
    annotatePlanInputSchema,
    async (rawArgs) => {
      const args = rawArgs as AnnotatePlanArgs;
      try {
        if (!context.rateLimiter.check("handoff_annotate_plan", "write")) {
          throw rateLimitError("handoff_annotate_plan");
        }

        log.debug(
          {
            taskId: args.taskId,
            planSize: args.planContent.length,
            sectionHeading: args.sectionHeading,
          },
          "handoff_annotate_plan called",
        );

        // Insert or update the annotation
        const annotatedPlan = insertPlanAnnotation(
          args.planContent,
          args.taskId,
          args.sectionHeading,
        );

        // Parse the resulting annotations for metadata
        const annotations = parsePlanAnnotations(annotatedPlan);

        log.info(
          {
            taskId: args.taskId,
            sectionHeading: args.sectionHeading ?? "(top)",
            annotationCount: annotations.length,
          },
          "handoff_annotate_plan completed",
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                annotatedPlan,
                annotations,
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
