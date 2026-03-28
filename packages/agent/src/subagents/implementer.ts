import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findTaskById,
  getLatestHumanComment,
  persistTaskPlanForTask,
  setTaskFields,
  incrementTaskTokenUsage,
  type TaskRow,
} from "@aif/data";
import { logger, formatAttachmentsForPrompt, looksLikeFullPlanUpdate } from "@aif/shared";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";
import { createClaudeStderrCollector } from "../claudeDiagnostics.js";
import { computePendingPlanLayers, computePlanLayers, formatLayerSummary } from "../planLayers.js";

const log = logger("implementer");
const AGENT_NAME = "implement-coordinator";
const FIX_PLAN_PATH = ".ai-factory/FIX_PLAN.md";
const PLAN_PATH = ".ai-factory/PLAN.md";

function formatLatestHumanCommentForPrompt(
  comment: {
    createdAt: string;
    message: string;
    attachments: string | null;
  } | null,
): string {
  if (!comment) return "No human comments found for rework request.";
  return [
    `[${comment.createdAt}] human`,
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

function readCanonicalPlan(task: { isFix: boolean }, projectRoot: string): string | null {
  const preferredPath = resolve(projectRoot, task.isFix ? FIX_PLAN_PATH : PLAN_PATH);
  if (existsSync(preferredPath)) {
    const content = readFileSync(preferredPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  const fallbackPath = resolve(projectRoot, task.isFix ? PLAN_PATH : FIX_PLAN_PATH);
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
  let resultText = "";
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

  for await (const message of query({
    prompt,
    options: {
      cwd: input.projectRoot,
      settingSources: ["project"],
      model: "haiku",
      maxThinkingTokens: 1024,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Do not use tools or subagents. Reply directly with markdown only.",
      },
    },
  })) {
    if (message.type !== "result") continue;
    incrementTaskTokenUsage(input.task.id, {
      ...message.usage,
      total_cost_usd: message.total_cost_usd,
    });
    if (message.subtype !== "success") {
      throw new Error(`Checklist sync failed: ${message.subtype}`);
    }
    resultText = message.result.trim();
  }

  if (!resultText) {
    throw new Error("Checklist sync did not return plan markdown");
  }
  return resultText;
}

function formatParsedPlanTasksForPrompt(
  parsedTasks: Array<{
    number: number;
    description: string;
    phase: number;
    explicitDependencies: number[];
    completed: boolean;
  }>,
  hasPlanText: boolean,
): string {
  if (!hasPlanText) return "No plan text available.";
  if (parsedTasks.length === 0) {
    return (
      "No structured checklist/tasks were parsed from plan. " +
      "Interpret the plan text directly and decide actionable implementation steps."
    );
  }

  return parsedTasks
    .sort((a, b) => a.number - b.number)
    .map((task) => {
      const state = task.completed ? "completed" : "pending";
      const deps =
        task.explicitDependencies.length > 0
          ? `; deps: ${task.explicitDependencies.join(", ")}`
          : "";
      return `- Task ${task.number} [${state}] (phase ${task.phase}): ${task.description}${deps}`;
    })
    .join("\n");
}

export async function runImplementer(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for implementation");
    throw new Error(`Task ${taskId} not found`);
  }
  const project = findProjectById(task.projectId);
  const implementerBudget = project?.implementerMaxBudgetUsd ?? null;
  const canonicalPlan = readCanonicalPlan(task, projectRoot);
  const selectedPlan = canonicalPlan ?? task.plan;
  const planSection = task.isFix
    ? `Primary plan file (use first): @${FIX_PLAN_PATH}
Fallback in-task plan copy:
${selectedPlan ?? "No in-task plan copy is available."}`
    : `${selectedPlan ?? "No plan available — use your best judgment."}`;
  const layerComputation = selectedPlan
    ? computePendingPlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedPlanComputation = selectedPlan
    ? computePlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedTasksSummary = formatParsedPlanTasksForPrompt(
    parsedPlanComputation.tasks,
    Boolean(selectedPlan),
  );
  const parsedTaskCount = parsedPlanComputation.tasks.length;
  const hasParallelLayer = layerComputation.layers.some((layer) => layer.length > 1);
  const layerSummary = formatLayerSummary(layerComputation.layers);
  const pendingTaskCount = layerComputation.tasks.length;
  const latestHumanComment = task.reworkRequested ? (getLatestHumanComment(taskId) ?? null) : null;

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
      updatedAt: nowIso,
    });
    setTaskFields(taskId, {
      implementationLog: noOpResult,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    logActivity(taskId, "Agent", `${AGENT_NAME} skipped — no pending tasks in plan`);
    log.info({ taskId }, "Implementer no-op: all plan tasks already completed");
    return;
  }

  log.info({ taskId, title: task.title }, "Starting implement-worker agent");

  const prompt = `Implement the following task according to the plan.

IMPORTANT: Your working directory is ${projectRoot}
All files must be created and modified inside this directory. Do NOT create files outside of it.

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Plan:
${planSection}

Parsed plan tasks (status + dependencies extracted by orchestrator):
${parsedTasksSummary}

Precomputed execution layers (source of truth from orchestrator):
${layerSummary}

${
  task.reworkRequested
    ? `Rework mode: true (requested from done/request_changes).
Latest human rework comment (must be addressed in this implementation run):
${formatLatestHumanCommentForPrompt(latestHumanComment)}`
    : "Rework mode: false."
}

Execution rules:
- Respect the precomputed layers above as authoritative dependency order.
- Any layer with multiple tasks MUST be executed via parallel \`implement-worker\` dispatch.
- Do not collapse parallel layers into sequential execution unless blocked by explicit conflicts.
- Run quality sidecars (review, security, best-practices) and verify the merged result.`;

  let implementWorkerStarts = 0;
  const stderrCollector = createClaudeStderrCollector();

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: AGENT_NAME,
    prompt,
    maxBudgetUsd: implementerBudget,
    agent: AGENT_NAME,
    extraSubagentStartHooks: [
      async (input) => {
        const data =
          input != null && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const agentName = String(
          data.agent_name ?? data.subagent_type ?? data.agent_type ?? data.description ?? "",
        ).toLowerCase();
        if (agentName.includes("implement-worker")) {
          implementWorkerStarts += 1;
        }
        return {};
      },
    ],
  });

  let finalResultText = resultText;

  if (isBlockedImplementationResult(resultText)) {
    throw new Error("Implementer blocked by permissions");
  }

  if (hasParallelLayer && implementWorkerStarts === 0) {
    const stderrTail = stderrCollector.getTail();
    if (
      stderrTail &&
      (stderrTail.toLowerCase().includes("stream closed") ||
        stderrTail.toLowerCase().includes("error in hook callback"))
    ) {
      throw new Error("Claude stream interrupted before implement-worker dispatch");
    }
    log.warn(
      { taskId, pendingLayerSummary: layerSummary },
      "Implementer finished without implement-worker dispatch for pending parallel layers",
    );
    finalResultText = `${resultText}\n\n[warning] No implement-worker dispatch detected for pending parallel layers. Execution was accepted in fallback mode.`;
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
