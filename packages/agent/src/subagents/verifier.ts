import { findProjectById, findTaskById, setTaskFields } from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logger } from "@aif/shared";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";
import { StageManualBlockError } from "../stageErrorHandler.js";
import { executeSubagentQuery } from "../subagentQuery.js";

const log = logger("verifier");

interface VerifyGateResult {
  status?: "pass" | "warn" | "fail";
  blocking?: boolean;
  blockers?: unknown[];
}

function extractVerifyGateResult(resultText: string): VerifyGateResult | null {
  const fence = resultText.match(/```aif-gate-result\s*([\s\S]*?)```/);
  if (!fence) return null;

  try {
    const parsed: unknown = JSON.parse(fence[1].trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      status:
        record.status === "pass" || record.status === "warn" || record.status === "fail"
          ? record.status
          : undefined,
      blocking: typeof record.blocking === "boolean" ? record.blocking : undefined,
      blockers: Array.isArray(record.blockers) ? record.blockers : undefined,
    };
  } catch {
    return null;
  }
}

export async function runVerifier(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for verify stage");
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

  const project = findProjectById(task.projectId);
  const sidecarBudget = project?.reviewSidecarMaxBudgetUsd ?? null;
  const verifySlashCommand = "/aif-verify";
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All file reads, searches, and verification commands must stay within this directory. Do NOT navigate to parent directories or other projects.`;
  const prompt = `${verifySlashCommand}

HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
Autonomous Handoff mode: true.
Do not ask interactive questions.
If verification finds issues, report them in the final aif-gate-result block and stop.

${scopeConstraint}

Task title: ${task.title}
Task description: ${task.description}`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "verifier",
    prompt,
    requiredCapabilities: [],
    fallbackSlashCommand: verifySlashCommand,
    fallbackStrategy: "slash_command",
    executionMode: "standard",
    sessionReusePolicy: "new_session",
    systemPromptAppend: scopeConstraint,
  });

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: "aif-verify",
    prompt,
    profileMode: "review",
    maxBudgetUsd: sidecarBudget,
    workflowSpec,
    workflowKind: "verifier",
    fallbackSlashCommand: verifySlashCommand,
  });

  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  const existingReview = task.reviewComments?.trim();
  const combinedReview = existingReview
    ? `${existingReview}\n\n## Verification\n\n${resultText}`
    : `## Verification\n\n${resultText}`;
  setTaskFields(taskId, {
    reviewComments: combinedReview,
    updatedAt: new Date().toISOString(),
  });

  const gate = extractVerifyGateResult(resultText);
  if (gate?.status === "fail" || gate?.blocking === true) {
    log.warn({ taskId, blockers: gate.blockers ?? [] }, "Verify stage returned blocking result");
    throw new StageManualBlockError(
      "Verify stage returned a blocking gate result. Review the Verification section for details.",
      "Verify stage returned a blocking gate result",
    );
  }

  logActivity(taskId, "Agent", "verify stage complete (aif-verify)");
  log.debug({ taskId, gateStatus: gate?.status ?? null }, "Verification report saved to task");
}
