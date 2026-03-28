import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectById, findTaskById, listTaskComments, persistTaskPlanForTask } from "@aif/data";
import { logger, formatAttachmentsForPrompt } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";

const log = logger("planner");
const AGENT_NAME = "plan-coordinator";
const FIX_SKILL_NAME = "aif-fix";

function extractPlanPathFromResult(resultText: string): string | null {
  const match = resultText.match(/plan written to\s+([^\n.]+(?:\.[a-z0-9]+)?)/i);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function readPlanFromDisk(projectRoot: string, resultText: string): string | null {
  const candidates = new Set<string>([
    resolve(projectRoot, ".ai-factory/PLAN.md"),
    resolve(projectRoot, ".ai-factory/FIX_PLAN.md"),
  ]);

  const pathFromResult = extractPlanPathFromResult(resultText);
  if (pathFromResult) {
    candidates.add(
      pathFromResult.startsWith("/") ? pathFromResult : resolve(projectRoot, pathFromResult),
    );
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf8").trim();
    if (content.length > 0) return content;
  }

  return null;
}

function normalizePlannerResult(resultText: string): string {
  const cleaned = resultText
    .replace(/^plan written to .*$/im, "")
    .replace(/^saved to .*$/im, "")
    .trim();

  return cleaned.length > 0 ? cleaned : resultText.trim();
}

function formatCommentsForPrompt(
  comments: Array<{
    author: "human" | "agent";
    message: string;
    attachments: string | null;
    createdAt: string;
  }>,
): string {
  if (comments.length === 0) return "No user comments were provided.";

  const latest = comments.slice(-1);
  return latest
    .map((comment, index) => {
      const formatted = formatAttachmentsForPrompt(comment.attachments);
      const attachmentLines =
        formatted === "No task attachments were provided." ? "    none" : formatted;

      return [
        `${index + 1}. [${comment.createdAt}] ${comment.author}`,
        `   message: ${comment.message}`,
        "   attachments:",
        attachmentLines,
      ].join("\n");
    })
    .join("\n\n");
}

function buildFixCommandText(title: string, description: string): string {
  const normalizedDescription = description.trim();
  const taskText =
    normalizedDescription.length > 0 ? `${title.trim()}\n\n${normalizedDescription}` : title.trim();
  return `/aif-fix --plan-first ${JSON.stringify(taskText)}`;
}

export async function runPlanner(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  const comments = listTaskComments(taskId).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  if (!task) {
    log.error({ taskId }, "Task not found for planning");
    throw new Error(`Task ${taskId} not found`);
  }

  const executionName = task.isFix ? FIX_SKILL_NAME : AGENT_NAME;
  log.info({ taskId, title: task.title, isFix: task.isFix }, "Starting planning flow");
  const project = findProjectById(task.projectId);
  const plannerBudget = project?.plannerMaxBudgetUsd ?? null;

  const hasComments = comments.length > 0;
  const isReplanning = hasComments || (task.plan && task.plan.trim().length > 0);

  const taskAttachmentsForPrompt = formatAttachmentsForPrompt(task.attachments);
  const commentsForPrompt = formatCommentsForPrompt(comments);
  const prompt = task.isFix
    ? buildFixCommandText(task.title, task.description)
    : isReplanning
      ? `Refine and improve the existing plan for the following task.
Mode: fast, tests: no, docs: no, max_iterations: 3.

Title: ${task.title}
Description: ${task.description}
Task attachments:
${taskAttachmentsForPrompt}
User comments and replanning feedback:
${commentsForPrompt}

Previous plan:
${task.plan ?? "(no previous plan)"}

Iterate on the plan using plan-polisher: critique the existing plan, address the feedback above, and refine until implementation-ready.`
      : `Plan the implementation for the following task.
Mode: fast, tests: no, docs: no, max_iterations: 3.

Title: ${task.title}
Description: ${task.description}
Task attachments:
${taskAttachmentsForPrompt}
User comments and replanning feedback:
${commentsForPrompt}

Create a concrete, implementation-ready plan using iterative refinement via plan-polisher.`;

  const { resultText: rawResult } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: executionName,
    prompt,
    maxBudgetUsd: plannerBudget,
    agent: task.isFix ? undefined : AGENT_NAME,
  });

  const diskPlan = readPlanFromDisk(projectRoot, rawResult);
  const resultText = diskPlan ?? normalizePlannerResult(rawResult);

  persistTaskPlanForTask({
    taskId,
    planText: resultText,
    projectRoot,
    isFix: task.isFix,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Plan saved to task");
}
