import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findTaskById,
  getLatestReworkComment,
  persistTaskPlanForTask,
  setTaskFields,
  type TaskRow,
} from "@aif/data";
import {
  logger,
  formatAttachmentsForPrompt,
  looksLikeFullPlanUpdate,
  getProjectConfig,
} from "@aif/shared";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";
import { computePendingPlanLayers, computePlanLayers } from "../planLayers.js";

const log = logger("implementer");
const AGENT_NAME = "implement-coordinator";

function formatReworkCommentForPrompt(
  comment: {
    author: string;
    createdAt: string;
    message: string;
    attachments: string | null;
  } | null,
): string {
  if (!comment) return "No rework comments found for rework request.";
  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    formatAttachmentsForPrompt(comment.attachments),
  ].join("\n");
}

function isBlockedImplementationResult(resultText: string): boolean {
  const normalized = resultText.toLowerCase();
  return (
    normalized.includes("status: blocked") ||
    normalized.includes("permission system") ||
    normalized.includes("permission denied") ||
    normalized.includes("write permission") ||
    normalized.includes("cannot proceed") ||
    normalized.includes("blocked —")
  );
}

function readCanonicalPlan(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string | null {
  const cfg = getProjectConfig(projectRoot);
  const preferredPath = resolve(
    projectRoot,
    task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan,
  );
  if (existsSync(preferredPath)) {
    const content = readFileSync(preferredPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  const fallbackPath = resolve(projectRoot, task.isFix ? cfg.paths.plan : cfg.paths.fix_plan);
  if (existsSync(fallbackPath)) {
    const content = readFileSync(fallbackPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  return null;
}

function getChecklistProgress(planText: string | null): {
  parsedTaskCount: number;
  pendingTaskCount: number;
} {
  if (!planText) return { parsedTaskCount: 0, pendingTaskCount: 0 };
  const parsed = computePlanLayers(planText);
  const pending = computePendingPlanLayers(planText);
  return {
    parsedTaskCount: parsed.tasks.length,
    pendingTaskCount: pending.tasks.length,
  };
}

async function runChecklistSyncQuery(input: {
  task: TaskRow;
  projectRoot: string;
  planText: string;
  implementationResult: string;
}): Promise<string> {
  const prompt = `You are finalizing task checklist state in a markdown implementation plan.

TASK TITLE:
${input.task.title}

TASK DESCRIPTION:
${input.task.description}

IMPLEMENTATION RESULT LOG (source of truth for what was done):
${input.implementationResult}

CURRENT PLAN MARKDOWN:
<<<CURRENT_PLAN
${input.planText}
CURRENT_PLAN

Requirements:
1) Return the FULL updated plan markdown.
2) Update only checkbox states ("- [ ]" / "- [x]") to reflect implemented work from the log.
3) Do not rewrite structure, titles, ordering, prose, or dependencies.
4) Preserve all unchecked tasks that are not completed yet.
5) Output markdown only.
6) Do not use tools or subagents.`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer_checklist_sync",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly with markdown only.",
    metadata: {
      checklistSync: true,
    },
  });

  const { resultText } = await executeSubagentQuery({
    taskId: input.task.id,
    projectRoot: input.projectRoot,
    agentName: "implement-checklist-sync",
    prompt,
    workflowSpec,
    workflowKind: "implementer_checklist_sync",
  });
  const normalizedResult = resultText.trim();
  if (!normalizedResult) {
    throw new Error("Checklist sync did not return plan markdown");
  }
  return normalizedResult;
}

export async function runImplementer(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for implementation");
    throw new Error(`Task ${taskId} not found`);
  }
  const project = findProjectById(task.projectId);
  const implementerBudget = project?.implementerMaxBudgetUsd ?? null;
  const useSubagents = task.useSubagents;
  const executionName = useSubagents ? AGENT_NAME : "aif-implement";
  const cfg = getProjectConfig(projectRoot);
  const canonicalPlan = readCanonicalPlan(task, projectRoot);
  const selectedPlan = canonicalPlan ?? task.plan;
  const effectivePlanPath = task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;
  const planSection = `@${effectivePlanPath}`;
  const layerComputation = selectedPlan
    ? computePendingPlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedPlanComputation = selectedPlan
    ? computePlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedTaskCount = parsedPlanComputation.tasks.length;
  const pendingTaskCount = layerComputation.tasks.length;
  const latestReworkComment = task.reworkRequested
    ? (getLatestReworkComment(taskId) ?? null)
    : null;

  if (selectedPlan && parsedTaskCount > 0 && pendingTaskCount === 0 && !task.reworkRequested) {
    const nowIso = new Date().toISOString();
    const noOpResult =
      "No pending tasks detected in plan (all tasks already completed). " +
      "Implementer skipped coordinator execution.";
    persistTaskPlanForTask({
      taskId,
      planText: selectedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
    setTaskFields(taskId, {
      implementationLog: noOpResult,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    logActivity(taskId, "Agent", `${executionName} skipped — no pending tasks in plan`);
    log.info({ taskId }, "Implementer no-op: all plan tasks already completed");
    return;
  }

  log.info({ taskId, title: task.title, useSubagents }, "Starting implementation stage");
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All files must be created and modified inside this directory. Do NOT create files outside of it.`;
  const implementSlashCommand = `/aif-implement ${planSection}`;
  const handoffContext = `HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
HANDOFF_SKIP_REVIEW: ${task.skipReview ? "1" : "0"}`;

  const isRework = task.reworkRequested;

  // Rework header is surfaced loudly so the model cannot miss that this is
  // a reopened task with an explicit human/agent rework comment.
  const reworkHeaderBlock = isRework
    ? `================================================
  REWORK REQUEST — THIS IS THE PRIMARY TASK
================================================

You are addressing a REWORK REQUEST on a previously-completed task. The rework comment below is your PRIMARY instruction — it supersedes the checklist state of the plan. The task was previously marked DONE, but the reviewer is NOT satisfied and has requested changes. Address EXACTLY the request below. Do not re-do previously completed work unless the request explicitly asks for it.

<<<REWORK_COMMENT
${formatReworkCommentForPrompt(latestReworkComment)}
REWORK_COMMENT

================================================
`
    : "";

  const reworkProtocolBlock = isRework
    ? `

Rework handling protocol:
1) FIRST, restate the rework request in your own words (1-2 sentences) so it's clear you understood it. Reference specific files, functions, or plan items mentioned in the request.
2) Identify which files in the codebase and/or plan items need to change to satisfy the request.
3) Make the minimal set of changes required. Do NOT refactor unrelated code.
4) If the rework request cannot be satisfied (e.g. it asks for something impossible or contradicts an earlier decision), say so EXPLICITLY in the final result text — do not silently skip it or claim "already done".
5) If the plan checklist shows all items completed, do not interpret that as "nothing to do" — the rework comment is the source of truth for this run.`
    : "";

  const reworkSystemAppend = isRework
    ? "\n\nREWORK MODE: A previously-completed task has been reopened. The rework comment inside the prompt is the primary instruction. Do not treat a fully-checked plan as 'nothing to do'."
    : "";

  const effectiveSystemAppend = `${scopeConstraint}${reworkSystemAppend}`;

  // For coordinator mode the rework header goes at the very top of the prompt
  // so it cannot be buried below the lead line. For skill mode we keep the
  // slash command on the first line so Claude Code still expands it, and
  // surface the rework header inside the body instead.
  const topReworkHeader = useSubagents ? reworkHeaderBlock : "";
  const bodyReworkHeader = useSubagents ? "" : reworkHeaderBlock;

  const prompt = `${topReworkHeader}${useSubagents ? "Implement the task using the provided plan." : implementSlashCommand}

${
  useSubagents
    ? `${handoffContext}
Autonomous Handoff mode: true.
Do not ask interactive questions.
Do not perform Handoff MCP sync yourself.
`
    : ""
}

${scopeConstraint}

${bodyReworkHeader}Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Plan path:
${planSection}

${isRework ? "Rework mode: true (requested from done/request_changes)." : "Rework mode: false."}

Execution rules:
- Respect task dependencies and checklist state from the plan file.
- Keep plan checklist state accurate while implementing.
- Run tests/lint/verification relevant to the changes.
- IMPORTANT: The plan file is ${effectivePlanPath}. Always read from and annotate this exact file — do not create plan files at other paths.${reworkProtocolBlock}`;
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer",
    prompt,
    requiredCapabilities: useSubagents ? ["supportsAgentDefinitions"] : [],
    agentDefinitionName: useSubagents ? AGENT_NAME : undefined,
    fallbackSlashCommand: implementSlashCommand,
    fallbackStrategy: useSubagents ? "slash_command" : "none",
    executionMode: useSubagents ? "native_subagents" : "standard",
    // Rework must always start a fresh session — resuming an old thread
    // leads Claude to treat the completed work as authoritative and ignore
    // the new rework request.
    sessionReusePolicy: isRework ? "never" : "resume_if_available",
    systemPromptAppend: effectiveSystemAppend,
    metadata: {
      reworkRequested: task.reworkRequested,
      skipReview: task.skipReview ?? false,
    },
  });

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: executionName,
    prompt,
    maxBudgetUsd: implementerBudget,
    agent: useSubagents ? AGENT_NAME : undefined,
    skipReview: task.skipReview ?? false,
    workflowSpec,
    workflowKind: "implementer",
    fallbackSlashCommand: implementSlashCommand,
  });

  let finalResultText = resultText;

  if (isBlockedImplementationResult(resultText)) {
    throw new Error("Implementer blocked by permissions");
  }

  let syncedPlan = readCanonicalPlan(task, projectRoot) ?? task.plan;
  let checklistAutoSynced = false;
  const checklistBeforeSync = getChecklistProgress(syncedPlan);

  if (
    syncedPlan &&
    checklistBeforeSync.parsedTaskCount > 0 &&
    checklistBeforeSync.pendingTaskCount > 0
  ) {
    const repairedPlan = await runChecklistSyncQuery({
      task,
      projectRoot,
      planText: syncedPlan,
      implementationResult: finalResultText,
    });
    if (looksLikeFullPlanUpdate(syncedPlan, repairedPlan)) {
      syncedPlan = repairedPlan;
      checklistAutoSynced = true;
    } else {
      log.warn(
        { taskId },
        "Checklist auto-sync returned non-plan-like response, keeping original plan",
      );
    }
  }

  const checklistAfterSync = getChecklistProgress(syncedPlan);
  const checklistWarning =
    syncedPlan && checklistAfterSync.parsedTaskCount > 0 && checklistAfterSync.pendingTaskCount > 0
      ? `[warning] Checklist remains incomplete after auto-sync: ${checklistAfterSync.pendingTaskCount} pending task(s).`
      : null;
  if (checklistWarning) {
    log.warn(
      { taskId, pendingTaskCount: checklistAfterSync.pendingTaskCount },
      "Checklist remains incomplete after auto-sync; continuing without blocking",
    );
  }

  const finalResultNotes: string[] = [];
  if (checklistAutoSynced) {
    finalResultNotes.push("[note] Plan checklist auto-synced after implementation.");
  }
  if (checklistWarning) {
    finalResultNotes.push(checklistWarning);
  }
  const enrichedResult =
    finalResultNotes.length > 0
      ? `${finalResultText}\n\n${finalResultNotes.join("\n")}`
      : finalResultText;

  const nowIso = new Date().toISOString();
  if (syncedPlan) {
    persistTaskPlanForTask({
      taskId,
      planText: syncedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
  }

  setTaskFields(taskId, {
    implementationLog: enrichedResult,
    reworkRequested: false,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
  });

  log.debug({ taskId }, "Implementation log saved to task");
}
