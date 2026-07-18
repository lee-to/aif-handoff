import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectById, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { getProjectConfig, logger, looksLikeFullPlanUpdate } from "@aif/shared";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";

const log = logger("improver");

function effectivePlanPath(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string {
  const cfg = getProjectConfig(projectRoot);
  return task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;
}

function readPlanFromDisk(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string | null {
  const path = resolve(projectRoot, effectivePlanPath(task, projectRoot));
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  return content.length > 0 ? content : null;
}

export async function runImprover(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for improve stage");
    throw new Error(`Task ${taskId} not found`);
  }

  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  const currentPlan = readPlanFromDisk(task, projectRoot) ?? task.plan;
  if (!currentPlan || currentPlan.trim().length === 0) {
    throw new Error("Improve stage requires a persisted plan");
  }

  const project = findProjectById(task.projectId);
  const planCheckerBudget = project?.planCheckerMaxBudgetUsd ?? null;
  const planPath = effectivePlanPath(task, projectRoot);
  const improveSlashCommand = `/aif-improve @${planPath}`;
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All file reads, searches, and plan updates must stay within this directory. Do NOT navigate to parent directories or other projects.`;
  const prompt = `${improveSlashCommand}

HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
Autonomous Handoff mode: true.
Do not ask interactive questions.
Apply useful plan refinements directly to @${planPath}; if no changes are needed, leave the plan unchanged.

${scopeConstraint}

Task title: ${task.title}
Task description: ${task.description}`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "improver",
    prompt,
    requiredCapabilities: [],
    fallbackSlashCommand: improveSlashCommand,
    fallbackStrategy: "slash_command",
    executionMode: "standard",
    sessionReusePolicy: "resume_if_available",
    systemPromptAppend: scopeConstraint,
  });

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: "aif-improve",
    prompt,
    profileMode: "plan",
    maxBudgetUsd: planCheckerBudget,
    workflowSpec,
    workflowKind: "improver",
    fallbackSlashCommand: improveSlashCommand,
  });

  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  const improvedPlan = readPlanFromDisk(task, projectRoot);
  if (!improvedPlan) {
    throw new Error("Improve stage did not leave a readable plan");
  }

  if (!looksLikeFullPlanUpdate(currentPlan, improvedPlan)) {
    log.warn(
      {
        taskId,
        originalLength: currentPlan.length,
        improvedLength: improvedPlan.length,
        resultPreview: resultText.slice(0, 200),
      },
      "Improve stage produced a non-plan-like update; preserving previous plan",
    );
    persistTaskPlanForTask({
      taskId,
      planText: currentPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  persistTaskPlanForTask({
    taskId,
    planText: improvedPlan,
    projectRoot,
    isFix: task.isFix,
    planPath: task.planPath,
    updatedAt: new Date().toISOString(),
  });
  logActivity(taskId, "Agent", "improve stage complete (aif-improve)");
  log.debug({ taskId }, "Improved plan saved to task");
}
