import { query } from "@anthropic-ai/claude-agent-sdk";
import { incrementTaskTokenUsage } from "@aif/data";
import { modelOption } from "@aif/shared";
import { getClaudePath } from "./hooks.js";

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

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      cwd: input.projectRoot,
      env: process.env,
      pathToClaudeCodeExecutable: getClaudePath(),
      settingSources: ["project"],
      ...modelOption("haiku"),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Do not use tools or subagents. Reply directly in plain text.",
      },
    },
  })) {
    if (message.type !== "result") continue;
    incrementTaskTokenUsage(input.taskId, {
      ...message.usage,
      total_cost_usd: message.total_cost_usd,
    });
    if (message.subtype !== "success") {
      throw new Error(`Review auto-check failed: ${message.subtype}`);
    }
    resultText = message.result.trim();
  }

  if (!resultText) {
    throw new Error("Review auto-check returned empty response");
  }

  if (resultText.toUpperCase() === SUCCESS_TOKEN) {
    return { status: "success" };
  }

  const trimmedLines = resultText
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
