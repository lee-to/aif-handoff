import { findProjectById, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { logger, looksLikeFullPlanUpdate } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";

const log = logger("plan-checker");
const AGENT_NAME = "plan-checker";

export function normalizeMarkdownFence(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (!fenced) return text.trim();
  return fenced[1].trim();
}

export function hasChecklistItems(text: string): boolean {
  return /^\s*[-*]\s+\[(?: |x|X)\]\s+/m.test(text);
}

/** Count plain bullet items that could be converted to checkboxes. */
export function countConvertibleBullets(text: string): number {
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    // Plain bullet that is NOT already a checkbox
    if (/^\s*[-*]\s+(?!\[(?: |x|X)\])/.test(line)) {
      // Skip lines that look like headings/context (too short or no actionable verb)
      const content = line.replace(/^\s*[-*]\s+/, "").trim();
      if (content.length > 3) count++;
    }
  }
  return count;
}

/** Convert plain bullet items to checkboxes locally (no LLM needed). */
export function convertBulletsToCheckboxes(text: string): string {
  return text.replace(/^(\s*)([-*])\s+(?!\[(?: |x|X)\])/gm, "$1$2 [ ] ");
}

/** Check if the plan already uses checklist format throughout. */
export function isPlanAlreadyChecklist(text: string): boolean {
  const convertible = countConvertibleBullets(text);
  return hasChecklistItems(text) && convertible === 0;
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

  // Fast path: skip LLM call if plan already has proper checklist format
  if (isPlanAlreadyChecklist(task.plan)) {
    log.info({ taskId }, "Plan already in checklist format — skipping plan-checker agent");
    return;
  }

  // Try local conversion first — if only simple bullet→checkbox conversion is needed
  const convertible = countConvertibleBullets(task.plan);
  if (convertible > 0 && hasChecklistItems(task.plan)) {
    const locallyConverted = convertBulletsToCheckboxes(task.plan);
    if (isPlanAlreadyChecklist(locallyConverted)) {
      log.info(
        { taskId, convertedItems: convertible },
        "Converted plain bullets to checkboxes locally — skipping plan-checker agent",
      );
      persistTaskPlanForTask({
        taskId,
        planText: locallyConverted,
        projectRoot,
        isFix: task.isFix,
        planPath: task.planPath ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
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
5) Return the FULL updated plan markdown, not a partial snippet.
6) Return only the corrected plan markdown, no explanations.
7) Do not use tools or subagents.`;

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: AGENT_NAME,
    prompt,
    profileMode: "plan",
    maxBudgetUsd: planCheckerBudget,
  });

  const normalizedPlan = normalizeMarkdownFence(resultText);
  if (normalizedPlan.length === 0) {
    throw new Error("Plan checker returned empty content");
  }

  const hasChecklist = hasChecklistItems(normalizedPlan);
  const looksLikeFull = looksLikeFullPlanUpdate(task.plan, normalizedPlan);

  if (!hasChecklist || !looksLikeFull) {
    log.warn(
      {
        taskId,
        hasChecklist,
        looksLikeFull,
        originalLength: task.plan.length,
        returnedLength: normalizedPlan.length,
        preview: normalizedPlan.slice(0, 200),
      },
      "Plan checker returned non-plan-like content; attempting local fallback",
    );

    // Fallback: try local conversion of the ORIGINAL plan
    const fallback = convertBulletsToCheckboxes(task.plan);
    if (hasChecklistItems(fallback)) {
      log.info({ taskId }, "Local fallback conversion succeeded — saving converted plan");
      persistTaskPlanForTask({
        taskId,
        planText: fallback,
        projectRoot,
        isFix: task.isFix,
        planPath: task.planPath ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    log.warn({ taskId }, "Local fallback also failed; keeping existing task plan");
    return;
  }

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot,
    isFix: task.isFix,
    planPath: task.planPath ?? undefined,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Verified plan saved to task");
}
