import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findTaskById,
  listTaskComments,
  persistTaskPlanForTask,
  setTaskFields,
} from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logger, formatAttachmentsForPrompt, getProjectConfig } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";
import { assertCurrentBranch, ensureFeatureBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";

const log = logger("planner");
const AGENT_NAME = "plan-coordinator";
const FIX_SKILL_NAME = "aif-fix";

function extractPlanPathFromResult(resultText: string): string | null {
  const patterns = [/plan written to\s+([^\n]+)/i, /saved to\s+([^\n]+)/i];

  for (const pattern of patterns) {
    const match = resultText.match(pattern);
    if (!match) continue;
    const normalized = normalizeExtractedPlanPath(match[1]);
    if (normalized) return normalized;
  }

  return null;
}

function normalizeExtractedPlanPath(pathText: string): string | null {
  const normalized = pathText
    .trim()
    .replace(/^[@`"'(\[]+/, "")
    .replace(/[)\].,`"']+$/, "")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePlanPath(path: string | null | undefined, projectRoot: string): string {
  const defaultPlan = getProjectConfig(projectRoot).paths.plan;
  if (!path) return defaultPlan;
  return path.trim().replace(/^@+/, "") || defaultPlan;
}

function readPlanFromDisk(
  projectRoot: string,
  resultText: string,
  isFix: boolean,
  customPlanPath?: string,
): string | null {
  const cfg = getProjectConfig(projectRoot);
  const normalizedPlanPath = normalizePlanPath(customPlanPath, projectRoot);
  const canonicalPlanPath = resolve(projectRoot, isFix ? cfg.paths.fix_plan : normalizedPlanPath);
  const candidatePaths = new Set<string>([canonicalPlanPath]);
  const pathFromResult = extractPlanPathFromResult(resultText);
  if (pathFromResult) {
    const resolved = pathFromResult.startsWith("/")
      ? pathFromResult
      : resolve(projectRoot, pathFromResult);
    candidatePaths.add(resolved);
  }

  // Skill runs may write fallback paths even when @path is requested.
  if (isFix) {
    candidatePaths.add(resolve(projectRoot, "FIX_PLAN.md"));
  } else {
    candidatePaths.add(resolve(projectRoot, cfg.paths.plan));
    candidatePaths.add(resolve(projectRoot, "PLAN.md"));
  }

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;
    const content = readFileSync(candidatePath, "utf8").trim();
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

function buildFixCommandText(taskContext: string): string {
  return `/aif-fix --plan-first ${JSON.stringify(taskContext)}`;
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

  const useSubagents = task.useSubagents;
  const executionName = task.isFix ? FIX_SKILL_NAME : useSubagents ? AGENT_NAME : "aif-plan";
  log.info({ taskId, title: task.title, isFix: task.isFix }, "Starting planning flow");
  const project = findProjectById(task.projectId);
  const plannerBudget = project?.plannerMaxBudgetUsd ?? null;

  const taskAttachmentsForPrompt = formatAttachmentsForPrompt(task.attachments);
  const commentsForPrompt = formatCommentsForPrompt(comments);

  const plannerMode = task.plannerMode || "full";
  const planPath = normalizePlanPath(task.planPath, projectRoot);
  const planDocs = task.planDocs ? "true" : "false";
  const planTests = task.planTests ? "true" : "false";

  // Deterministic branch handling — runs regardless of whether the subagent
  // skill honors Step 1.4. Only activates for full-mode plans; fast mode stays
  // on current branch by design. See aif-handoff#83.
  //
  // Two paths:
  //   - First-time provisioning (no persisted branchName): use
  //     ensureFeatureBranch which can create from base.
  //   - Re-run / replan (task.branchName already persisted): use
  //     restorePersistedBranch so config drift cannot release us to current
  //     HEAD via the `skipped` shortcut, and a deleted branch errors out
  //     instead of being silently re-created from base.
  //
  // Failures throw BranchIsolationError (dirty worktree, missing base branch,
  // checkout failure, branch_missing, etc). The coordinator classifies it as
  // blocked_external with retryAfter=null so an operator can inspect the work
  // tree instead of the stage silently reverting into a bad state.
  let preparedBranch: string | null = task.branchName ?? null;
  if (plannerMode === "full" && !task.isFix) {
    if (task.branchName) {
      restorePersistedBranch({
        projectRoot,
        taskId,
        persistedBranchName: task.branchName,
      });
      preparedBranch = task.branchName;
      logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
    } else {
      const branchResult = ensureFeatureBranch({
        projectRoot,
        taskId,
        title: task.title,
      });
      if (branchResult.action !== "skipped" && branchResult.branchName) {
        preparedBranch = branchResult.branchName;
        setTaskFields(taskId, {
          branchName: branchResult.branchName,
          updatedAt: new Date().toISOString(),
        });
        logActivity(
          taskId,
          "Agent",
          `Feature branch ${branchResult.action}: ${branchResult.branchName}`,
        );
      } else if (branchResult.reason) {
        log.debug({ taskId, reason: branchResult.reason }, "Branch creation skipped");
      }
    }
  }

  const taskContext = `Title: ${task.title}
Description: ${task.description}
Task attachments:
${taskAttachmentsForPrompt}
User comments and replanning feedback:
${commentsForPrompt}`;
  let prompt: string;
  let workflowSpec: ReturnType<typeof createRuntimeWorkflowSpec>;
  // HANDOFF_BRANCH_PREPARED=1 tells the aif-plan / plan-polisher skill that
  // Handoff already owns branch creation for this run. The skill MUST NOT
  // execute its own `git checkout -b`; it should validate that the current
  // branch matches HANDOFF_BRANCH_NAME and report a blocker if not. See
  // ai-factory#96.
  const handoffBranchLines = preparedBranch
    ? `\nHANDOFF_BRANCH_PREPARED: 1\nHANDOFF_BRANCH_NAME: ${preparedBranch}`
    : "";
  const handoffContext = `HANDOFF_MODE: 1\nHANDOFF_TASK_ID: ${taskId}${handoffBranchLines}`;
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}\nAll files must be created and modified inside this directory. Do NOT navigate to parent directories or other projects.`;
  const plannerSlashCommand = `/aif-plan ${plannerMode} @${planPath} docs:${planDocs} tests:${planTests}`;

  if (task.isFix) {
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${buildFixCommandText(taskContext)}`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
    });
  } else if (useSubagents) {
    prompt = `Plan the implementation for the following task.

${handoffContext}
${scopeConstraint}

Mode: ${plannerMode}, tests: ${planTests}, docs: ${planDocs}.
Plan file: @${planPath}

${taskContext}

Create or refine an implementation-ready markdown checklist plan.
Always write the final plan to @${planPath}.`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: ["supportsAgentDefinitions"],
      agentDefinitionName: AGENT_NAME,
      fallbackSlashCommand: plannerSlashCommand,
      fallbackStrategy: "slash_command",
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  } else {
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${plannerSlashCommand}

${taskContext}`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  }

  const { resultText: rawResult } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: executionName,
    prompt,
    profileMode: "plan",
    maxBudgetUsd: plannerBudget,
    agent: task.isFix || !useSubagents ? undefined : AGENT_NAME,
    workflowSpec,
    workflowKind: "planner",
    fallbackSlashCommand: task.isFix ? undefined : plannerSlashCommand,
  });

  // Detect skill-level branch drift: if the planner subagent (or its
  // nested plan-polisher) silently created or switched to a different
  // branch than the one we prepared, the plan we're about to persist
  // belongs to the wrong HEAD. Surface as BranchIsolationError so the
  // coordinator blocks the task instead of committing the drift.
  if (preparedBranch) {
    assertCurrentBranch(projectRoot, preparedBranch);
  }

  const diskPlan = readPlanFromDisk(projectRoot, rawResult, !!task.isFix, planPath);
  const resultText = diskPlan ?? normalizePlannerResult(rawResult);

  persistTaskPlanForTask({
    taskId,
    planText: resultText,
    projectRoot,
    isFix: task.isFix,
    planPath,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Plan saved to task");
}
