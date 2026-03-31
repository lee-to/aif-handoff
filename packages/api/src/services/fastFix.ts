import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseAttachments, modelOption } from "@aif/shared";
import { incrementTaskTokenUsage } from "@aif/data";

interface FastFixComment {
  author: string;
  message: string;
  attachments: string | null;
  createdAt: string;
}

interface RunFastFixQueryInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  latestComment: FastFixComment;
  projectRoot: string;
  planPath: string;
  previousPlan: string;
  priorAttempt?: string;
  shouldTryFileUpdate?: boolean;
}

function formatLatestCommentForPrompt(comment: FastFixComment): string {
  const attachments = parseAttachments(comment.attachments);
  const attachmentLines = attachments.length
    ? attachments
        .map((file, index) => {
          let detail: string;
          if (file.content) {
            detail = `\n     content:\n${file.content
              .slice(0, 4000)
              .split("\n")
              .map((line) => `       ${line}`)
              .join("\n")}`;
          } else if (file.path) {
            detail = `\n     file: ${file.path}`;
          } else {
            detail = "\n     content: [not provided]";
          }
          return `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)${detail}`;
        })
        .join("\n")
    : "none";

  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    attachmentLines,
  ].join("\n");
}

export async function runFastFixQuery(input: RunFastFixQueryInput): Promise<string> {
  const includeFileUpdateStep = input.shouldTryFileUpdate ?? true;
  const prompt = input.priorAttempt
    ? `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.taskTitle}

TASK DESCRIPTION:
${input.taskDescription}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

PLAN PATH (must be the only plan file you update):
@${input.planPath}

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

PRIOR ATTEMPT THAT WAS TOO SHORT (do not use as final output):
<<<PRIOR_ATTEMPT
${input.priorAttempt}
PRIOR_ATTEMPT

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${
  includeFileUpdateStep
    ? `4) Also update the plan file @${input.planPath} in the workspace (if you can access files/tools): overwrite it with the FULL updated plan.\n5) Do not create or modify any other plan file paths.\n6) Output markdown only in your final response.`
    : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."
}`
    : `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.taskTitle}

TASK DESCRIPTION:
${input.taskDescription}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

PLAN PATH (must be the only plan file you update):
@${input.planPath}

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${
  includeFileUpdateStep
    ? `4) Also update the plan file @${input.planPath} in the workspace (if you can access files/tools): overwrite it with the FULL updated plan.\n5) Do not create or modify any other plan file paths.\n6) Output markdown only in your final response.`
    : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."
}`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      cwd: input.projectRoot,
      settingSources: ["project"],
      ...modelOption("haiku"),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(includeFileUpdateStep
          ? {}
          : { append: "Do not use tools or subagents. Reply directly with markdown only." }),
      },
    },
  })) {
    if (message.type !== "result") continue;
    incrementTaskTokenUsage(input.taskId, {
      ...message.usage,
      total_cost_usd: message.total_cost_usd,
    });
    if (message.subtype !== "success") {
      throw new Error(`Fast fix failed: ${message.subtype}`);
    }
    resultText = message.result.trim();
  }

  if (!resultText) {
    throw new Error("Fast fix did not return updated plan text");
  }
  return resultText;
}

export { withTimeout } from "@aif/shared";
