import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { modelOption } from "@aif/shared";
import { executeSubagentQuery } from "./subagentQuery.js";

type ReviewGateResult = { status: "success" } | { status: "request_changes"; fixes: string };

interface ReviewGateInput {
  taskId: string;
  projectRoot: string;
  reviewComments: string | null;
}

const SUCCESS_TOKEN = "SUCCESS";

export async function evaluateReviewCommentsForAutoMode(
  input: ReviewGateInput,
): Promise<ReviewGateResult> {
  const selectedModel = modelOption("haiku");
  const suppressModelFallback = !("model" in selectedModel);
  const normalizedComments = (input.reviewComments ?? "").trim();
  const prompt = `Read the review comments and extract only the points that must be fixed.

Review comments:
${normalizedComments.length > 0 ? normalizedComments : "No review comments provided."}

Rules:
1) If there are no issues that require fixes, return exactly one word: SUCCESS
2) If there are issues, return ONLY markdown bullet points in this exact format: "- <required fix>"
3) Output must be either:
   - exactly "SUCCESS"
   - or one or more lines, each starting with "- "
4) Do not include numbering, headings, prose, code fences, or any extra text`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "review-gate",
    prompt,
    requiredCapabilities: [],
    fallbackStrategy: "none",
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  const { resultText } = await executeSubagentQuery({
    taskId: input.taskId,
    projectRoot: input.projectRoot,
    agentName: "review-gate",
    prompt,
    workflowSpec,
    workflowKind: "review-gate",
    modelOverride: "model" in selectedModel ? selectedModel.model : null,
    suppressModelFallback,
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  const normalizedResultText = resultText.trim();
  if (!normalizedResultText) {
    throw new Error("Review auto-check returned empty response");
  }

  if (normalizedResultText.toUpperCase() === SUCCESS_TOKEN) {
    return { status: "success" };
  }

  const trimmedLines = normalizedResultText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bulletLines = trimmedLines.filter((line) => line.startsWith("- "));
  const hasOnlyBulletLines = bulletLines.length > 0 && bulletLines.length === trimmedLines.length;

  // Enforce strict format from prompt:
  // - either SUCCESS
  // - or only "- " bullet lines.
  // Any mixed/prose output is treated as success to avoid false rework loops.
  if (!hasOnlyBulletLines) {
    return { status: "success" };
  }

  return {
    status: "request_changes",
    fixes: bulletLines.join("\n"),
  };
}
