import { findProjectById, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { logger } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";

const log = logger("plan-checker");
const AGENT_NAME = "plan-checker";

function normalizeMarkdownFence(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (!fenced) return text.trim();
  return fenced[1].trim();
}

export async function runPlanChecker(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for plan checklist verification");
    throw new Error(`Task ${taskId} not found`);
  }

  if (!task.plan || task.plan.trim().length === 0) {
    log.warn({ taskId }, "Skipping plan checklist verification: task has no plan");
    return;
  }
  const project = findProjectById(task.projectId);
  const planCheckerBudget = project?.planCheckerMaxBudgetUsd ?? null;

  log.info({ taskId, title: task.title }, "Starting plan-checker agent");

  const prompt = `You are validating an implementation plan markdown before coding starts.
Task title: ${task.title}

Current plan markdown:
${task.plan}

Requirements:
1) Ensure the plan is a checklist where actionable items use markdown checkboxes in "- [ ] Item" format.
2) Convert plain bullet tasks into unchecked checkboxes when needed.
3) Keep headings and non-actionable context text intact.
4) Preserve completed items "- [x]" as completed.
5) Return only the corrected plan markdown, no explanations.`;

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: AGENT_NAME,
    prompt,
    maxBudgetUsd: planCheckerBudget,
  });

  const normalizedPlan = normalizeMarkdownFence(resultText);
  if (normalizedPlan.length === 0) {
    throw new Error("Plan checker returned empty content");
  }

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot,
    isFix: task.isFix,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Verified plan saved to task");
}
