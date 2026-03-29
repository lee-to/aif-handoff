import { findProjectById, findTaskById, setTaskFields } from "@aif/data";
import { logger, formatAttachmentsForPrompt, getEnv } from "@aif/shared";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery, startHeartbeat } from "../subagentQuery.js";

const log = logger("reviewer");

async function runSidecar(
  prompt: string,
  taskId: string,
  projectRoot: string,
  agentName: string,
  maxBudgetUsd: number | null,
  useSubagentAgent: boolean,
): Promise<string> {
  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName,
    prompt,
    maxBudgetUsd,
    agent: useSubagentAgent ? agentName : undefined,
  });
  return resultText;
}

export async function runReviewer(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for review");
    throw new Error(`Task ${taskId} not found`);
  }

  const project = findProjectById(task.projectId);
  const sidecarBudget = project?.reviewSidecarMaxBudgetUsd ?? null;
  const useSubagents = getEnv().AGENT_USE_SUBAGENTS;

  log.info({ taskId, title: task.title, useSubagents }, "Starting review stage");

  const reviewPromptBase = `Review the implementation for this task:

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Implementation Log:
${task.implementationLog ?? "No implementation log available."}

Review changed code for correctness, regression risks, performance, and maintainability.`;

  const securityPromptBase = `Audit the implementation for security risks:

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Focus on auth, validation, secrets, injection, and unsafe shell/file handling in changed code.`;
  const reviewPrompt = useSubagents ? reviewPromptBase : `/aif-review ${reviewPromptBase}`;
  const securityPrompt = useSubagents
    ? securityPromptBase
    : `/aif-security-checklist ${securityPromptBase}`;
  const reviewAgentName = useSubagents ? "review-sidecar" : "aif-review";
  const securityAgentName = useSubagents ? "security-sidecar" : "aif-security-checklist";

  try {
    const heartbeatTimer = startHeartbeat(taskId);

    let reviewResult = "";
    let securityResult = "";
    try {
      if (useSubagents) {
        [reviewResult, securityResult] = await Promise.all([
          runSidecar(reviewPrompt, taskId, projectRoot, reviewAgentName, sidecarBudget, true),
          runSidecar(securityPrompt, taskId, projectRoot, securityAgentName, sidecarBudget, true),
        ]);
      } else {
        reviewResult = await runSidecar(
          reviewPrompt,
          taskId,
          projectRoot,
          reviewAgentName,
          sidecarBudget,
          false,
        );
        securityResult = await runSidecar(
          securityPrompt,
          taskId,
          projectRoot,
          securityAgentName,
          sidecarBudget,
          false,
        );
      }
    } finally {
      try {
        clearInterval(heartbeatTimer);
      } catch {
        /* safety guard */
      }
    }

    log.info({ taskId }, "Review and security sidecars completed");

    const combinedReview = `## Code Review\n\n${reviewResult}\n\n## Security Audit\n\n${securityResult}`;

    setTaskFields(taskId, {
      reviewComments: combinedReview,
      updatedAt: new Date().toISOString(),
    });

    logActivity(
      taskId,
      "Agent",
      useSubagents
        ? "review stage complete (review-sidecar + security-sidecar)"
        : "review stage complete (aif-review + aif-security-checklist)",
    );
    log.debug({ taskId }, "Review comments saved to task");
  } catch (err) {
    logActivity(taskId, "Agent", `review stage failed — ${(err as Error).message}`);
    throw err;
  }
}
