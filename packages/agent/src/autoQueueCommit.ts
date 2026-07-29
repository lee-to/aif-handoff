import { appendTaskActivityLog, findTaskById, getAutoQueueMode, setTaskFields } from "@aif/data";
import { createRuntimeWorkflowSpec, UsageSource } from "@aif/runtime";
import {
  assertCurrentBranch,
  buildCommitPrompt,
  countCommitsBetween,
  describeDirtyWorkingTree,
  getHeadCommitSha,
  isGitRepo,
  logger,
  restorePersistedBranch,
} from "@aif/shared";
import { executeSubagentQuery } from "./subagentQuery.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("auto-queue-commit");
const PROJECT_SCOPE_APPEND =
  "Project scope rule: work strictly inside the current working directory. " +
  "Do not inspect or modify parent or sibling directories.";

export type AutoQueueCommitOutcome =
  | { status: "not_required" | "not_applicable" | "no_changes"; commitSha: null }
  | { status: "committed"; commitSha: string };

function recordCommitOutcome(
  taskId: string,
  outcome:
    | { status: "committed"; commitSha: string }
    | { status: "no_changes" | "not_applicable"; commitSha: null },
): void {
  const completedAt = new Date().toISOString();
  setTaskFields(taskId, {
    autoQueueCommitStatus: outcome.status,
    commitSha: outcome.commitSha,
    autoQueueCommitError: null,
    autoQueueCommitCompletedAt: completedAt,
    updatedAt: completedAt,
  });
  appendTaskActivityLog(
    taskId,
    outcome.status === "committed"
      ? `[${completedAt}] [auto-queue-commit] Commit verified: ${outcome.commitSha}`
      : `[${completedAt}] [auto-queue-commit] ${outcome.status}`,
  );
  log.info(
    { taskId, status: outcome.status, commitSha: outcome.commitSha },
    "Auto-queue commit gate completed",
  );
}

function blockForCommitFailure(taskId: string, reason: string, err?: unknown): never {
  const failedAt = new Date().toISOString();
  setTaskFields(taskId, {
    autoQueueCommitStatus: "failed",
    commitSha: null,
    autoQueueCommitError: reason,
    autoQueueCommitCompletedAt: null,
    updatedAt: failedAt,
  });
  appendTaskActivityLog(taskId, `[${failedAt}] [auto-queue-commit] Failed: ${reason}`);
  log.error({ taskId, err, reason }, "Auto-queue commit gate failed");
  throw new StageManualBlockError(reason);
}

function isVerifiedSingleCommit(
  projectRoot: string,
  beforeSha: string | null,
  afterSha: string | null,
): afterSha is string {
  if (!afterSha || afterSha === beforeSha) return false;
  if (!beforeSha) return true;
  return countCommitsBetween(projectRoot, beforeSha, afterSha) === 1;
}

function reconcileCleanTree(input: {
  taskId: string;
  projectRoot: string;
  baseSha: string | null;
  currentSha: string | null;
}): AutoQueueCommitOutcome {
  const { taskId, projectRoot, baseSha, currentSha } = input;
  if (currentSha && currentSha !== baseSha) {
    recordCommitOutcome(taskId, { status: "committed", commitSha: currentSha });
    return { status: "committed", commitSha: currentSha };
  }
  recordCommitOutcome(taskId, { status: "no_changes", commitSha: null });
  log.debug({ taskId, projectRoot }, "Auto-queue commit skipped because work tree is clean");
  return { status: "no_changes", commitSha: null };
}

export async function ensureAutoQueueTaskCommit(input: {
  taskId: string;
  projectRoot: string;
}): Promise<AutoQueueCommitOutcome> {
  const task = findTaskById(input.taskId);
  if (!task) {
    throw new StageManualBlockError(`Auto-queue commit failed: task ${input.taskId} not found.`);
  }

  if (task.autoQueueCommitStatus === "committed" && task.commitSha) {
    return { status: "committed", commitSha: task.commitSha };
  }
  if (
    task.autoQueueCommitStatus === "no_changes" ||
    task.autoQueueCommitStatus === "not_applicable"
  ) {
    return { status: task.autoQueueCommitStatus, commitSha: null };
  }

  const autoQueueEnabled = getAutoQueueMode(task.projectId);
  if (!autoQueueEnabled && task.autoQueueCommitStatus == null) {
    return { status: "not_required", commitSha: null };
  }

  const executionRoot = task.worktreePath ?? input.projectRoot;
  if (!isGitRepo(executionRoot)) {
    recordCommitOutcome(task.id, { status: "not_applicable", commitSha: null });
    return { status: "not_applicable", commitSha: null };
  }

  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot: executionRoot,
      taskId: task.id,
      persistedBranchName: task.branchName,
    });
  }

  const currentSha = getHeadCommitSha(executionRoot);
  const baseSha = task.autoQueueCommitStatus == null ? currentSha : task.autoQueueCommitBaseSha;
  if (task.autoQueueCommitStatus == null) {
    setTaskFields(task.id, {
      autoQueueCommitStatus: "pending",
      autoQueueCommitBaseSha: baseSha,
      commitSha: null,
      autoQueueCommitError: null,
      autoQueueCommitCompletedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  const dirtyBefore = describeDirtyWorkingTree(executionRoot);
  log.info(
    {
      taskId: task.id,
      projectId: task.projectId,
      executionRoot,
      baseSha,
      currentSha,
      dirty: Boolean(dirtyBefore),
    },
    "Evaluating auto-queue commit gate",
  );

  if (!dirtyBefore) {
    return reconcileCleanTree({
      taskId: task.id,
      projectRoot: executionRoot,
      baseSha,
      currentSha,
    });
  }

  setTaskFields(task.id, {
    autoQueueCommitStatus: "running",
    autoQueueCommitError: null,
    updatedAt: new Date().toISOString(),
  });

  const prompt = buildCommitPrompt(false);
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "commit",
    prompt,
    fallbackSlashCommand: "/aif-commit",
    sessionReusePolicy: "never",
    systemPromptAppend: PROJECT_SCOPE_APPEND,
  });

  let runtimeError: unknown;
  try {
    await executeSubagentQuery({
      taskId: task.id,
      projectRoot: executionRoot,
      agentName: "aif-commit",
      prompt,
      profileMode: "task",
      workflowSpec,
      workflowKind: "commit",
      fallbackSlashCommand: "/aif-commit",
      sessionReusePolicy: "never",
      systemPromptAppend: PROJECT_SCOPE_APPEND,
      usageSource: UsageSource.COMMIT,
    });
  } catch (err) {
    runtimeError = err;
  }

  if (task.branchName && !task.isFix) {
    try {
      assertCurrentBranch(executionRoot, task.branchName);
    } catch (err) {
      return blockForCommitFailure(
        task.id,
        "Auto-queue commit changed the task branch. Restore the task branch and retry.",
        err,
      );
    }
  }

  const afterSha = getHeadCommitSha(executionRoot);
  const dirtyAfter = describeDirtyWorkingTree(executionRoot);
  const commitVerified = !dirtyAfter && isVerifiedSingleCommit(executionRoot, currentSha, afterSha);

  if (commitVerified) {
    recordCommitOutcome(task.id, { status: "committed", commitSha: afterSha });
    return { status: "committed", commitSha: afterSha };
  }

  const reason = runtimeError
    ? "Auto-queue commit runtime failed before a clean commit was verified. Inspect agent logs and retry."
    : dirtyAfter
      ? "Auto-queue commit left uncommitted changes. Inspect the work tree and retry."
      : "Auto-queue commit did not create exactly one commit. Inspect agent logs and retry.";
  return blockForCommitFailure(task.id, reason, runtimeError);
}
