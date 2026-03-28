import { findProjectById, findTaskById, setTaskFields } from "@aif/data";
import { logger, formatAttachmentsForPrompt } from "@aif/shared";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery, startHeartbeat } from "../subagentQuery.js";

const log = logger("reviewer");

async function runSidecar(
  prompt: string,
  taskId: string,
  projectRoot: string,
  agentName: string,
  maxBudgetUsd: number | null,
): Promise<string> {
  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName,
    prompt,
    maxBudgetUsd,
    agent: agentName,
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

  log.info({ taskId, title: task.title }, "Starting review + security sidecars");

  const reviewPrompt = `Review the implementation for this task:

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Implementation Log:
${task.implementationLog ?? "No implementation log available."}

Review changed code for correctness, regression risks, performance, and maintainability.`;

  const securityPrompt = `Audit the implementation for security risks:

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Focus on auth, validation, secrets, injection, and unsafe shell/file handling in changed code.`;

  try {
    const heartbeatTimer = startHeartbeat(taskId);

    let reviewResult = "";
    let securityResult = "";
    try {
      [reviewResult, securityResult] = await Promise.all([
        runSidecar(reviewPrompt, taskId, projectRoot, "review-sidecar", sidecarBudget),
        runSidecar(securityPrompt, taskId, projectRoot, "security-sidecar", sidecarBudget),
      ]);
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

    logActivity(taskId, "Agent", "review stage complete (review-sidecar + security-sidecar)");
    log.debug({ taskId }, "Review comments saved to task");
  } catch (err) {
    logActivity(taskId, "Agent", `review stage failed — ${(err as Error).message}`);
    throw err;
  }
}
