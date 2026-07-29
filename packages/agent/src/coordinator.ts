import {
  clearTaskActiveRuntimeSelection,
  clearTaskRuntimeLimitSnapshot,
  blockTaskForRuntimeGateIfEligible,
  evaluateRuntimeLimitGate,
  findCoordinatorTaskCandidatesForProject,
  listCoordinatorActionableProjectIds,
  findProjectById,
  hasActiveLockedTaskForProject,
  claimCoordinatorTaskIfEligible,
  releaseTaskClaim,
  releaseStaleTaskClaims,
  updateTaskStatus as updateTaskStatusRow,
  listDueScheduledTasks,
  appendTaskActivityLog,
  listAutoQueueProjects,
  nextBacklogTaskByPosition,
  countActivePipelineTasksForProject,
  hasActiveBranchBoundTasksForProject,
  hasBlockingAutoQueueCommitForProject,
  claimBacklogTaskForAdvance,
  persistTaskRuntimeLimitSnapshot,
  resolveEffectiveRuntimeProfile,
  type CoordinatorStage,
  type ProjectRow,
  type TaskFieldsPatch,
  type TaskRow,
} from "@aif/data";
import { initProject, type RuntimeRegistry } from "@aif/runtime";
import {
  logger,
  getEnv,
  CLEAN_STATE_RESET,
  getHeadCommitSha,
  withTimeout,
  type TaskStatus,
} from "@aif/shared";
import { runPlanner } from "./subagents/planner.js";
import { runImprover } from "./subagents/improver.js";
import { runPlanChecker } from "./subagents/planChecker.js";
import { runImplementer } from "./subagents/implementer.js";
import { runReviewer } from "./subagents/reviewer.js";
import { runVerifier } from "./subagents/verifier.js";
import {
  describeDirtyWorkingTree,
  isGitRepo,
  projectSupportsTaskWorktrees,
  projectUsesSharedBranchIsolation,
} from "./gitBranch.js";
import { flushActivityQueue } from "./hooks.js";
import {
  notifyTaskBroadcast,
  notifyProjectBroadcast,
  type TaskNotificationInfo,
} from "./notifier.js";
import { handleAutoReviewGate } from "./autoReviewHandler.js";
import { classifyStageError } from "./stageErrorHandler.js";
import { setActiveStageAbortController } from "./stageAbort.js";
import { setCoordinatorId } from "./subagentQuery.js";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import {
  getRandomBackoffMinutes,
  releaseDueBlockedTasks,
  recoverStaleInProgressTasks,
} from "./taskWatchdog.js";

const log = logger("coordinator");
const env = getEnv();
const AUTO_QUEUE_COMMIT_GATE_ENABLED = env.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED;
const STAGE_RUN_TIMEOUT_MS = Math.max(env.AGENT_STAGE_RUN_TIMEOUT_MS, 60_000);
const CLAIM_LOCK_DURATION_MS = STAGE_RUN_TIMEOUT_MS + 5 * 60 * 1000; // stage timeout + 5 min buffer
export const COORDINATOR_ID = crypto.randomUUID();

let _runtimeRegistry: RuntimeRegistry | null = null;
export function setRuntimeRegistry(registry: RuntimeRegistry): void {
  _runtimeRegistry = registry;
}
setCoordinatorId(COORDINATOR_ID);

const runtimeCounters = {
  fastRetryStreamInterruptions: 0,
};

interface StatusTransition {
  from: TaskStatus[];
  inProgress: TaskStatus;
  onSuccess: TaskStatus;
  runner: (taskId: string, projectRoot: string) => Promise<void>;
  label: CoordinatorStage;
}

const PIPELINE: StatusTransition[] = [
  {
    from: ["planning"],
    inProgress: "planning",
    onSuccess: "plan_ready",
    runner: runPlanner,
    label: "planner",
  },
  {
    from: ["improve"],
    inProgress: "improve",
    onSuccess: "plan_ready",
    runner: runImprover,
    label: "improver",
  },
  {
    from: ["plan_ready"],
    inProgress: "plan_ready",
    onSuccess: "plan_ready",
    runner: runPlanChecker,
    label: "plan-checker",
  },
  {
    from: ["plan_ready", "implementing"],
    inProgress: "implementing",
    onSuccess: "review",
    runner: runImplementer,
    label: "implementer",
  },
  {
    from: ["verify"],
    inProgress: "verify",
    onSuccess: "review",
    runner: runVerifier,
    label: "verifier",
  },
  {
    from: ["review"],
    inProgress: "review",
    onSuccess: "done",
    runner: runReviewer,
    label: "reviewer",
  },
];

// ── Stage Semaphore ──────────────────────────────────────────

class StageSemaphore {
  private counts = new Map<string, number>();
  private activeCount = 0;
  private waiters: Array<{
    key: string;
    keyMax: number;
    globalMax: number;
    resolve: () => void;
  }> = [];

  private canAcquire(key: string, keyMax: number, globalMax: number): boolean {
    const current = this.counts.get(key) ?? 0;
    return current < keyMax && this.activeCount < globalMax;
  }

  tryAcquire(key: string, keyMax: number, globalMax: number): boolean {
    if (!this.canAcquire(key, keyMax, globalMax)) return false;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.activeCount += 1;
    return true;
  }

  acquire(key: string, keyMax: number, globalMax: number): Promise<void> {
    if (this.tryAcquire(key, keyMax, globalMax)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ key, keyMax, globalMax, resolve });
    });
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 0) return;

    if (current === 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
    this.activeCount -= 1;
    this.drainWaiters();
  }

  totalActive(): number {
    return this.activeCount;
  }

  trackedKeyCount(): number {
    return this.counts.size;
  }

  waitingCount(): number {
    return this.waiters.length;
  }

  reset(): void {
    if (this.waiters.length > 0) {
      throw new Error("Cannot reset stage semaphore while acquisitions are queued");
    }
    this.counts.clear();
    this.activeCount = 0;
  }

  private drainWaiters(): void {
    let granted = true;
    while (granted) {
      granted = false;
      const waiterIndex = this.waiters.findIndex((waiter) =>
        this.canAcquire(waiter.key, waiter.keyMax, waiter.globalMax),
      );
      if (waiterIndex < 0) return;

      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (!waiter) return;

      this.counts.set(waiter.key, (this.counts.get(waiter.key) ?? 0) + 1);
      this.activeCount += 1;
      waiter.resolve();
      granted = true;
    }
  }
}

const stageSemaphore = new StageSemaphore();

// ── Public API ───────────────────────────────────────────────

export function getCoordinatorRuntimeCounters(): Readonly<typeof runtimeCounters> {
  return { ...runtimeCounters };
}

export function resetCoordinatorRuntimeCountersForTests(): void {
  runtimeCounters.fastRetryStreamInterruptions = 0;
}

export function getStageSemaphore(): StageSemaphore {
  return stageSemaphore;
}

// ── Stage execution ──────────────────────────────────────────

async function runStageWithTimeout(
  runner: (taskId: string, projectRoot: string) => Promise<void>,
  taskId: string,
  projectRoot: string,
  stageLabel: string,
): Promise<void> {
  const abort = new AbortController();
  setActiveStageAbortController(taskId, abort);

  try {
    await withTimeout(
      runner(taskId, projectRoot),
      STAGE_RUN_TIMEOUT_MS,
      `Stage ${stageLabel} timed out after ${STAGE_RUN_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    if (!abort.signal.aborted) {
      abort.abort();
      log.warn({ taskId, stage: stageLabel }, "Aborted subagent process after stage timeout");
    }
    throw err;
  } finally {
    setActiveStageAbortController(taskId, null);
  }
}

/** Update task status with optional field overrides and broadcast. */
function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: Omit<TaskFieldsPatch, "status" | "lastHeartbeatAt" | "updatedAt"> = {},
  info: TaskNotificationInfo = {},
): void {
  updateTaskStatusRow(taskId, status, extra);
  const broadcastType =
    info.fromStatus && info.fromStatus === status ? "task:updated" : "task:moved";
  void notifyTaskBroadcast(taskId, broadcastType, { ...info, toStatus: status });
}

async function ensureCommitBeforeTerminalStatus(task: TaskRow, projectRoot: string): Promise<void> {
  if (!AUTO_QUEUE_COMMIT_GATE_ENABLED) {
    return;
  }
  try {
    await ensureAutoQueueTaskCommit({ taskId: task.id, projectRoot });
  } finally {
    flushActivityQueue(task.id);
  }
}

function resolveAutoQueueCommitPreparation(
  projectRoot: string,
): { status: "pending"; baseSha: string | null } | { status: "not_applicable"; baseSha: null } {
  return isGitRepo(projectRoot)
    ? { status: "pending", baseSha: getHeadCommitSha(projectRoot) }
    : { status: "not_applicable", baseSha: null };
}

function projectRequiresSerialExecution(project: ProjectRow): boolean {
  const hasSharedBranchTask = hasActiveBranchBoundTasksForProject(project.id);
  const taskWorktreesUnavailable =
    !env.AIF_TASK_WORKTREES_ENABLED || !projectSupportsTaskWorktrees(project.rootPath);
  const usesSharedBranchIsolation =
    projectUsesSharedBranchIsolation(project.rootPath) && taskWorktreesUnavailable;
  const usesAutoQueueSharedGitWorktree =
    AUTO_QUEUE_COMMIT_GATE_ENABLED &&
    project.autoQueueMode &&
    isGitRepo(project.rootPath) &&
    taskWorktreesUnavailable;

  return hasSharedBranchTask || usesSharedBranchIsolation || usesAutoQueueSharedGitWorktree;
}

function scheduledTaskHasDirtyAutoQueueWorktree(
  task: TaskRow,
  project: ProjectRow | null | undefined,
): boolean {
  if (!AUTO_QUEUE_COMMIT_GATE_ENABLED || !project?.autoQueueMode) {
    return false;
  }

  const projectRoot = task.worktreePath ?? project.rootPath;
  const dirtyPreview = isGitRepo(projectRoot) ? describeDirtyWorkingTree(projectRoot) : null;
  if (!dirtyPreview) {
    return false;
  }

  log.warn(
    { taskId: task.id, projectId: task.projectId, projectRoot, dirtyPreview },
    "Scheduled auto-queue task deferred because its Git worktree is dirty",
  );
  return true;
}

function runtimeProfileModeForStage(stage: CoordinatorStage): "task" | "plan" | "review" {
  if (stage === "planner" || stage === "improver" || stage === "plan-checker") {
    return "plan";
  }
  if (stage === "reviewer" || stage === "verifier") {
    return "review";
  }
  return "task";
}

function shouldRunSkillsModeImprove(task: TaskRow): boolean {
  return task.runPlanImprove && !task.useSubagents;
}

function shouldRunSkillsModeVerify(task: TaskRow): boolean {
  return task.runPostVerify && !task.useSubagents;
}

function getStageSuccessStatus(task: TaskRow, stage: StatusTransition): TaskStatus {
  if (stage.label === "planner" && shouldRunSkillsModeImprove(task)) {
    return "improve";
  }
  if (stage.label === "implementer" && shouldRunSkillsModeVerify(task)) {
    return "verify";
  }
  if (stage.label === "verifier" && task.skipReview) {
    return "done";
  }
  return stage.onSuccess;
}

function resolveRuntimeGateRetryAfter(gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>): {
  retryAfter: string;
  source: "resetAt" | "retryAfterSeconds" | "random_backoff";
} {
  if (gateDecision.futureHint.resetAt && gateDecision.futureHint.isFuture) {
    return {
      retryAfter: gateDecision.futureHint.resetAt,
      source: gateDecision.futureHint.source.includes("retry_after")
        ? "retryAfterSeconds"
        : "resetAt",
    };
  }

  if (
    typeof gateDecision.futureHint.retryAfterSeconds === "number" &&
    Number.isFinite(gateDecision.futureHint.retryAfterSeconds) &&
    gateDecision.futureHint.retryAfterSeconds >= 0
  ) {
    return {
      retryAfter: new Date(
        Date.now() + gateDecision.futureHint.retryAfterSeconds * 1000,
      ).toISOString(),
      source: "retryAfterSeconds",
    };
  }

  return {
    retryAfter: new Date(Date.now() + getRandomBackoffMinutes() * 60_000).toISOString(),
    source: "random_backoff",
  };
}

function buildRuntimeGateBlockedReason(
  gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>,
): string {
  const snapshot = gateDecision.snapshot;
  const hintSource = gateDecision.futureHint.source;
  const scope = gateDecision.violatedWindow?.scope ?? snapshot?.primaryScope ?? "runtime";
  if (gateDecision.reason === "exact_threshold") {
    const thresholdWindow = gateDecision.violatedWindow;
    if (thresholdWindow) {
      const thresholdValue = thresholdWindow.warningThreshold ?? snapshot?.warningThreshold;
      const percentRemaining = thresholdWindow.percentRemaining;
      if (typeof percentRemaining === "number" && typeof thresholdValue === "number") {
        return `Coordinator pre-start runtime gate: ${scope} threshold reached (${percentRemaining}% <= ${thresholdValue}%; hint=${hintSource})`;
      }
    }
    return `Coordinator pre-start runtime gate: ${scope} threshold reached (hint=${hintSource})`;
  }

  return `Coordinator pre-start runtime gate: ${scope} limit still blocked (hint=${hintSource})`;
}

function proactivelyBlockTaskForRuntimeGate(
  task: TaskRow,
  stage: CoordinatorStage,
  selection: ReturnType<typeof resolveEffectiveRuntimeProfile>,
  gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>,
): void {
  const snapshot = gateDecision.snapshot;
  const { retryAfter, source } = resolveRuntimeGateRetryAfter(gateDecision);
  const blockedReason = buildRuntimeGateBlockedReason(gateDecision);
  const retryCount = (task.retryCount ?? 0) + 1;
  const persistedAt = new Date().toISOString();
  const applied = blockTaskForRuntimeGateIfEligible({
    taskId: task.id,
    expectedProjectId: task.projectId,
    expectedStatus: task.status,
    expectedAutoMode: task.status === "plan_ready" ? task.autoMode === true : undefined,
    blockedFromStatus: task.status,
    blockedReason,
    retryAfter,
    retryCount,
    snapshot,
    persistedAt,
  });

  if (!applied) {
    log.debug(
      {
        taskId: task.id,
        stage,
        runtimeProfileId: selection.profile?.id ?? null,
      },
      "Skipped proactive runtime gate block because candidate changed before CAS update",
    );
    return;
  }

  appendTaskActivityLog(
    task.id,
    `[${persistedAt}] Coordinator runtime gate blocked task before ${stage}: profile=${selection.profile?.id ?? "none"} source=${selection.source} retryAfter=${retryAfter} retryAfterSource=${source}`,
  );
  void notifyTaskBroadcast(task.id, "task:moved", {
    title: task.title,
    fromStatus: task.status,
    toStatus: "blocked_external",
  });

  log.info(
    {
      taskId: task.id,
      stage,
      projectId: task.projectId,
      runtimeProfileId: selection.profile?.id ?? null,
      runtimeSelectionSource: selection.source,
      providerId: snapshot?.providerId ?? selection.profile?.providerId ?? null,
      runtimeId: snapshot?.runtimeId ?? selection.profile?.runtimeId ?? null,
      limitStatus: snapshot?.status ?? null,
      limitPrecision: snapshot?.precision ?? null,
      retryAfter,
      retryAfterSource: source,
      applied,
    },
    "Blocked task before claim due to runtime limit gate",
  );
}

function blockCandidateIfRuntimeLimited(task: TaskRow, stage: StatusTransition): boolean {
  const runtimeSelection = resolveEffectiveRuntimeProfile({
    taskId: task.id,
    projectId: task.projectId,
    mode: runtimeProfileModeForStage(stage.label),
  });
  const gateDecision = evaluateRuntimeLimitGate(runtimeSelection.profile);
  if (!gateDecision.blocked) return false;

  log.debug(
    {
      taskId: task.id,
      stage: stage.label,
      projectId: task.projectId,
      runtimeProfileId: gateDecision.runtimeProfileId,
      runtimeSelectionSource: runtimeSelection.source,
      gateReason: gateDecision.reason,
      limitPrecision: gateDecision.snapshot?.precision ?? null,
    },
    "Task candidate blocked by proactive runtime gate",
  );
  proactivelyBlockTaskForRuntimeGate(task, stage.label, runtimeSelection, gateDecision);
  return true;
}

// ── Single task processing ───────────────────────────────────

/** Returns true on success, false on failure. */
async function processOneTask(task: TaskRow, stage: StatusTransition): Promise<boolean> {
  const project = findProjectById(task.projectId);

  if (!project) {
    log.error(
      { taskId: task.id, projectId: task.projectId },
      "Project not found for task, skipping",
    );
    return false;
  }

  if (_runtimeRegistry) {
    const initResult = initProject({
      projectRoot: task.worktreePath ?? project.rootPath,
      registry: _runtimeRegistry,
    });
    if (!initResult.ok) {
      log.error(
        { taskId: task.id, projectId: task.projectId, error: initResult.error },
        "Project .ai-factory/ scaffold missing and init failed, skipping task",
      );
      return false;
    }
  }

  log.info(
    {
      taskId: task.id,
      title: task.title,
      stage: stage.label,
      projectRoot: project.rootPath,
      worktreePath: task.worktreePath ?? null,
    },
    "Picked up task for processing",
  );
  const sourceStatus = task.status;
  const taskTitle = task.title;

  if (sourceStatus !== stage.inProgress) {
    clearTaskActiveRuntimeSelection(task.id);
  }
  updateTaskStatus(task.id, stage.inProgress, {}, { title: taskTitle, fromStatus: sourceStatus });

  log.debug(
    { taskId: task.id, from: sourceStatus, to: stage.inProgress },
    "Status transition (start)",
  );

  try {
    const executionRoot = task.worktreePath ?? project.rootPath;
    await runStageWithTimeout(stage.runner, task.id, executionRoot, stage.label);

    flushActivityQueue(task.id);

    if (stage.label === "implementer" && task.skipReview) {
      clearTaskActiveRuntimeSelection(task.id);
      clearTaskRuntimeLimitSnapshot(task.id);
      const doneStatus = shouldRunSkillsModeVerify(task) ? "verify" : "done";
      if (doneStatus === "done") {
        await ensureCommitBeforeTerminalStatus(task, project.rootPath);
      }
      updateTaskStatus(task.id, doneStatus, CLEAN_STATE_RESET, {
        title: taskTitle,
        fromStatus: stage.inProgress,
      });
      log.info(
        { taskId: task.id, from: stage.inProgress, to: doneStatus },
        shouldRunSkillsModeVerify(task)
          ? "Skip review enabled — bypassing review stage and moving to verify"
          : "Skip review enabled — bypassing review stage",
      );
      return true;
    }

    if (stage.label === "reviewer") {
      const outcome = await handleAutoReviewGate({
        taskId: task.id,
        projectRoot: task.worktreePath ?? project.rootPath,
      });

      if (outcome?.status === "manual_review_required") {
        await ensureCommitBeforeTerminalStatus(task, project.rootPath);
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          "done",
          {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
            retryCount: 0,
            reworkRequested: false,
            reviewIterationCount: outcome.currentIteration,
            manualReviewRequired: true,
            autoReviewState: outcome.autoReviewState,
          },
          {
            title: taskTitle,
            fromStatus: stage.inProgress,
          },
        );
        log.info(
          {
            taskId: task.id,
            from: stage.inProgress,
            to: "done",
            reviewIteration: outcome.currentIteration,
            handoffReason: outcome.handoffReason,
          },
          "Auto review gate stopped at manual review handoff",
        );
        return true;
      }

      if (outcome?.status === "rework_requested") {
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          "implementing",
          {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
            retryCount: 0,
            reworkRequested: true,
            reviewIterationCount: outcome.currentIteration,
            manualReviewRequired: false,
            autoReviewState: outcome.autoReviewState,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        log.info(
          {
            taskId: task.id,
            from: stage.inProgress,
            to: "implementing",
            reviewIteration: outcome.currentIteration,
          },
          "Auto review gate requested changes, restarting implementing stage",
        );
        return true;
      }

      if (outcome?.status === "accepted") {
        await ensureCommitBeforeTerminalStatus(task, project.rootPath);
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(task.id, "done", CLEAN_STATE_RESET, {
          title: taskTitle,
          fromStatus: stage.inProgress,
        });
        log.info(
          { taskId: task.id, from: stage.inProgress, to: "done" },
          "Auto review gate accepted review, moving to done",
        );
        return true;
      }
    }

    const successStatus = getStageSuccessStatus(task, stage);
    if (successStatus === "done" || successStatus === "verified") {
      await ensureCommitBeforeTerminalStatus(task, project.rootPath);
    }
    clearTaskActiveRuntimeSelection(task.id);
    clearTaskRuntimeLimitSnapshot(task.id);
    updateTaskStatus(
      task.id,
      successStatus,
      {
        ...CLEAN_STATE_RESET,
        reviewIterationCount: stage.label === "implementer" ? (task.reviewIterationCount ?? 0) : 0,
      },
      { title: taskTitle, fromStatus: stage.inProgress },
    );

    log.info(
      { taskId: task.id, from: stage.inProgress, to: successStatus },
      "Status transition (success)",
    );
    return true;
  } catch (err) {
    const recovery = classifyStageError({
      taskId: task.id,
      stageLabel: stage.label,
      sourceStatus,
      retryCount: task.retryCount ?? 0,
      err,
    });

    switch (recovery.kind) {
      case "fast_retry":
        runtimeCounters.fastRetryStreamInterruptions += 1;
        log.warn(
          {
            taskId: task.id,
            stage: stage.label,
            metric: "coordinator.fast_retry_stream_interruptions",
            fastRetryStreamInterruptions: runtimeCounters.fastRetryStreamInterruptions,
          },
          "Fast retry scheduled after transient stream interruption",
        );
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          stage.inProgress,
          {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;

      case "blocked_external":
        if (recovery.limitSnapshot) {
          persistTaskRuntimeLimitSnapshot(task.id, recovery.limitSnapshot);
        } else {
          clearTaskRuntimeLimitSnapshot(task.id);
        }
        updateTaskStatus(
          task.id,
          "blocked_external",
          {
            blockedReason: recovery.blockedReason,
            blockedFromStatus: stage.inProgress,
            retryAfter: recovery.retryAfter,
            retryCount: recovery.retryCount,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;

      case "revert":
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          stage.inProgress,
          {},
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;
    }

    flushActivityQueue(task.id);
    return false;
  }
}

// ── Scheduled-task trigger ───────────────────────────────────

/**
 * Fire due scheduled tasks into the planning stage.
 *
 * Backlog tasks with `scheduledAt <= now` transition to `planning` (same path
 * as the human `start_ai` event). Clears `scheduledAt` atomically, records an
 * activity-log entry, and broadcasts `task:scheduled_fired`.
 */
export function processDueScheduledTasks(): number {
  const nowIso = new Date().toISOString();
  const due = listDueScheduledTasks(nowIso);
  if (due.length === 0) {
    log.debug({ nowIso }, "No due scheduled tasks");
    return 0;
  }

  log.info({ dueCount: due.length, nowIso }, "Firing due scheduled tasks");

  let fired = 0;
  for (const task of due) {
    try {
      const project = findProjectById(task.projectId);
      if (scheduledTaskHasDirtyAutoQueueWorktree(task, project)) {
        continue;
      }
      const autoQueueCommit =
        AUTO_QUEUE_COMMIT_GATE_ENABLED && project?.autoQueueMode === true
          ? resolveAutoQueueCommitPreparation(task.worktreePath ?? project.rootPath)
          : undefined;
      // CAS-style claim: only proceed if the row is still backlog+unpaused
      // at the moment of the write. Prevents racing with auto-queue or with
      // a parallel coordinator instance.
      if (!claimBacklogTaskForAdvance(task.id, autoQueueCommit)) {
        log.debug({ taskId: task.id }, "Scheduler: task no longer backlog/unpaused, skipped");
        continue;
      }
      appendTaskActivityLog(
        task.id,
        `[${nowIso}] [scheduler] Fired scheduled task (was due at ${task.scheduledAt})`,
      );
      void notifyTaskBroadcast(task.id, "task:scheduled_fired", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "planning",
      });
      // Mirror the standard status broadcast that updateTaskStatus would
      // have sent, so kanban columns re-render through the existing
      // task:moved code path (and Telegram fires for the transition).
      void notifyTaskBroadcast(task.id, "task:moved", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "planning",
      });
      fired += 1;
      log.info(
        { taskId: task.id, title: task.title, scheduledAt: task.scheduledAt },
        "Scheduled task fired",
      );
    } catch (err) {
      log.error({ taskId: task.id, err }, "Failed to fire scheduled task");
    }
  }

  log.info({ fired, attempted: due.length }, "Scheduled-task trigger pass complete");
  return fired;
}

// ── Auto-queue advance ───────────────────────────────────────

/**
 * For each project with `autoQueueMode = true`, fill the pipeline up to the
 * project's pool depth by advancing backlog tasks (lowest `position` first)
 * into `planning`. Pool depth is `1` for sequential projects and
 * `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` for parallel projects, so the same
 * code path covers both:
 *   - non-parallel project: strict sequential — next task starts only after
 *     the previous reaches a terminal status (done/verified)
 *   - parallel project: keeps the in-flight count at the parallel cap
 *
 * "In flight" = any non-terminal pipeline status (planning..review and
 * blocked_external). Terminal = done/verified. Backlog itself is the source
 * pool and doesn't count.
 */
export function processAutoQueueAdvance(): number {
  const projects = listAutoQueueProjects();
  if (projects.length === 0) {
    log.debug("No projects with auto-queue mode enabled");
    return 0;
  }

  let advanced = 0;
  for (const project of projects) {
    // Serialization predicate combines:
    //   - current config (`git.create_branches=true` on a real git repo), AND
    //   - task state (any in-flight task already has a persisted branchName).
    //
    // Config alone is not enough: an operator can toggle `create_branches=off`
    // mid-pipeline. Legacy branch-bound tasks without worktreePath still
    // switch HEAD in the shared root, so they force serial execution. Projects
    // that support task worktrees can keep the parallel pool open because the
    // planner provisions an isolated cwd before mutating files.
    const requiresSerialExecution = projectRequiresSerialExecution(project);
    if (project.parallelEnabled && requiresSerialExecution) {
      log.warn(
        { projectId: project.id, projectRoot: project.rootPath },
        "Auto-queue parallel pool disabled while tasks share one Git working tree",
      );
    }
    const limit =
      project.parallelEnabled && !requiresSerialExecution
        ? env.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT
        : 1;
    let active = countActivePipelineTasksForProject(project.id);

    if (active >= limit) {
      log.debug(
        { projectId: project.id, active, limit },
        "Auto-queue: project pipeline at capacity, skipping",
      );
      continue;
    }

    if (AUTO_QUEUE_COMMIT_GATE_ENABLED && hasBlockingAutoQueueCommitForProject(project.id)) {
      log.warn(
        { projectId: project.id },
        "Auto-queue paused because a task has blocking commit state",
      );
      continue;
    }

    // Dirty-worktree gate. Terminal statuses (done/verified) don't
    // guarantee the previous task's diff was committed — manual-review
    // pauses the pipeline with a clean-status but dirty repo. Advancing
    // the next task now would let its planner create a feature branch
    // on top of stale changes (or fail checkout outright). Pause
    // auto-queue advance for this project until the work tree is clean.
    if (
      isGitRepo(project.rootPath) &&
      (!env.AIF_TASK_WORKTREES_ENABLED || !projectSupportsTaskWorktrees(project.rootPath))
    ) {
      const dirty = describeDirtyWorkingTree(project.rootPath);
      if (dirty) {
        log.warn(
          { projectId: project.id, projectRoot: project.rootPath, dirtyPreview: dirty },
          "Auto-queue paused: work tree has uncommitted changes from previous task",
        );
        continue;
      }
    }

    // Fill the pool up to the limit in this single tick. Loop bound keeps it
    // cheap (limit is small, default 3) and avoids waiting another full poll
    // cycle to start the second/third task.
    while (active < limit) {
      const next = nextBacklogTaskByPosition(project.id);
      if (!next) {
        log.debug(
          { projectId: project.id, active, limit },
          "Auto-queue: no more backlog tasks ready to advance",
        );
        break;
      }

      const nowIso = new Date().toISOString();
      try {
        // CAS-style claim: only proceed if the row is still backlog+unpaused.
        // If false, another pass (scheduler / parallel coordinator / human
        // start_ai click) won the race — re-read pool counters and continue.
        const autoQueueCommit = AUTO_QUEUE_COMMIT_GATE_ENABLED
          ? resolveAutoQueueCommitPreparation(next.worktreePath ?? project.rootPath)
          : undefined;
        if (!claimBacklogTaskForAdvance(next.id, autoQueueCommit)) {
          log.debug(
            { taskId: next.id, projectId: project.id },
            "Auto-queue: task no longer backlog/unpaused, skipped",
          );
          active = countActivePipelineTasksForProject(project.id);
          continue;
        }
        // Mirror the broadcast that updateTaskStatus would have produced for
        // the backlog → planning transition (CAS write skips it).
        void notifyTaskBroadcast(next.id, "task:moved", {
          title: next.title,
          fromStatus: next.status,
          toStatus: "planning",
        });
        appendTaskActivityLog(
          next.id,
          `[${nowIso}] [auto-queue] Advanced by project auto-queue mode (pool ${active + 1}/${limit})`,
        );
        void notifyProjectBroadcast(project.id, "project:auto_queue_advanced", {
          taskId: next.id,
        });
        advanced += 1;
        active += 1;
        log.info(
          {
            projectId: project.id,
            taskId: next.id,
            title: next.title,
            position: next.position,
            poolDepth: `${active}/${limit}`,
          },
          "Auto-queue advanced next backlog task",
        );
      } catch (err) {
        log.error({ projectId: project.id, taskId: next.id, err }, "Auto-queue advance failed");
        // Bail out of this project's loop on error; try again next tick.
        break;
      }
    }
  }

  if (advanced > 0) {
    log.info({ advanced, projectCount: projects.length }, "Auto-queue advance pass complete");
  }
  return advanced;
}

// ── Poll cycle ───────────────────────────────────────────────

let activePollPromise: Promise<void> | null = null;
let followUpPollRequested = false;

async function runPollCycle(): Promise<void> {
  log.debug("Starting poll cycle");

  // Release stale locks BEFORE watchdog — otherwise watchdog moves task to blocked_external
  // and the lock remains orphaned (heartbeat cleanup filters by in-progress status)
  const released = releaseStaleTaskClaims();
  if (released > 0) {
    log.info({ released }, "Released stale task claims");
  }

  releaseDueBlockedTasks();
  recoverStaleInProgressTasks();
  processDueScheduledTasks();
  processAutoQueueAdvance();

  const maxProjectLanes = env.COORDINATOR_MAX_CONCURRENT_PROJECTS;
  const globalMaxTasks = env.COORDINATOR_MAX_CONCURRENT_TASKS;

  // Track tasks that failed in this cycle — prevent re-picking in downstream stages
  const failedInCycle = new Set<string>();

  // Cache effective project concurrency settings to avoid repeated lookups.
  // Legacy branch-bound tasks without worktreePath still mutate one shared
  // projectRoot, so those projects stay serial until the legacy task drains.
  const projectConcurrencyCache = new Map<string, { parallel: boolean; max: number }>();
  function resolveProjectConcurrency(projectId: string): { parallel: boolean; max: number } {
    let cached = projectConcurrencyCache.get(projectId);
    if (cached === undefined) {
      const project = findProjectById(projectId);
      const configuredParallel = project?.parallelEnabled ?? false;
      // Mirror processAutoQueueAdvance: config OR task-state forces serial.
      const requiresSerialExecution = project ? projectRequiresSerialExecution(project) : false;
      cached = {
        parallel: configuredParallel && !requiresSerialExecution,
        max:
          configuredParallel && !requiresSerialExecution
            ? env.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT
            : 1,
      };
      if (configuredParallel && requiresSerialExecution) {
        log.warn(
          { projectId, projectRoot: project?.rootPath },
          "Project parallel execution forced to serial while tasks share one Git working tree",
        );
      }
      projectConcurrencyCache.set(projectId, cached);
    }
    return cached;
  }

  const projectIds = listCoordinatorActionableProjectIds(maxProjectLanes);
  if (projectIds.length === 0) {
    log.debug("No actionable project lanes");
    return;
  }

  log.debug(
    {
      projectIds,
      maxProjectLanes,
      globalMaxTasks,
      activeTasks: stageSemaphore.totalActive(),
    },
    "Coordinator project lanes selected",
  );

  async function processProjectLane(projectId: string): Promise<void> {
    for (const stage of PIPELINE) {
      const concurrency = resolveProjectConcurrency(projectId);
      const parallel = concurrency.parallel;
      const projectMax = concurrency.max;
      const stageKey = `${projectId}:${stage.label}`;

      const candidateWindow = Math.min(Math.max(projectMax * 5, projectMax), 50);
      const candidates = findCoordinatorTaskCandidatesForProject(
        projectId,
        stage.label,
        candidateWindow,
      ).filter((t) => !failedInCycle.has(t.id));

      if (candidates.length === 0) {
        log.debug({ stage: stage.label, projectId }, "No tasks to process in project lane");
        continue;
      }

      log.debug(
        {
          stage: stage.label,
          projectId,
          candidateCount: candidates.length,
          candidateWindow,
          projectMax,
          globalMaxTasks,
        },
        "Project lane task candidates selected",
      );

      const spawned: Promise<void>[] = [];

      try {
        for (const task of candidates) {
          // Per-project concurrency: non-parallel projects limited to 1 task at a time
          if (spawned.length >= projectMax) {
            log.debug(
              { taskId: task.id, projectId: task.projectId, projectMax },
              "Project at capacity, skipping task",
            );
            continue;
          }

          // Cross-cycle guard: for non-parallel projects, check DB for any active lock
          // (another concurrent poll cycle may have already claimed a task for this project)
          if (!parallel && hasActiveLockedTaskForProject(task.projectId)) {
            log.debug(
              { taskId: task.id, projectId: task.projectId },
              "Non-parallel project has active lock from another cycle, skipping",
            );
            continue;
          }

          if (blockCandidateIfRuntimeLimited(task, stage)) {
            continue;
          }

          await stageSemaphore.acquire(stageKey, projectMax, globalMaxTasks);
          let claimedTask: TaskRow | undefined;
          let claimOutcomeUncertain = false;
          let cleanupOwnedByTaskPromise = false;

          const releaseOwnedResources = (): void => {
            try {
              const taskIdToRelease =
                claimedTask?.id ?? (claimOutcomeUncertain ? task.id : undefined);
              if (taskIdToRelease) {
                releaseTaskClaim(taskIdToRelease, COORDINATOR_ID);
              }
            } catch (err) {
              log.error(
                { taskId: claimedTask?.id ?? task.id, stage: stage.label, err },
                "[FIX:149] Failed to release coordinator task claim",
              );
            } finally {
              stageSemaphore.release(stageKey);
            }
          };

          try {
            log.debug(
              { taskId: task.id, projectId: task.projectId, stage: stage.label },
              "[FIX:149] Revalidating task candidate after coordinator permit",
            );

            if (!parallel && hasActiveLockedTaskForProject(task.projectId)) {
              log.debug(
                { taskId: task.id, projectId: task.projectId },
                "Non-parallel project became active while waiting for permit, skipping",
              );
              continue;
            }

            if (blockCandidateIfRuntimeLimited(task, stage)) {
              continue;
            }

            claimOutcomeUncertain = true;
            claimedTask = claimCoordinatorTaskIfEligible({
              taskId: task.id,
              expectedProjectId: task.projectId,
              expectedStatus: task.status,
              expectedAutoMode: task.status === "plan_ready" ? task.autoMode : undefined,
              coordinatorId: COORDINATOR_ID,
              lockDurationMs: CLAIM_LOCK_DURATION_MS,
            });
            claimOutcomeUncertain = false;
            if (!claimedTask) {
              log.debug(
                { taskId: task.id, stage: stage.label, expectedStatus: task.status },
                "[FIX:149] Task candidate changed while waiting for permit, skipping",
              );
              continue;
            }
            const executionTask = claimedTask;

            log.debug(
              {
                stage: stage.label,
                taskId: executionTask.id,
                candidateStatus: executionTask.status,
                parallel,
              },
              "[FIX:149] Task revalidated and claimed for processing",
            );

            const taskPromise = processOneTask(executionTask, stage)
              .then((success) => {
                if (!success) failedInCycle.add(executionTask.id);
              })
              .catch((err) => {
                failedInCycle.add(executionTask.id);
                log.error(
                  { taskId: executionTask.id, stage: stage.label, err },
                  "Unexpected error in task processing",
                );
              })
              .finally(releaseOwnedResources);

            spawned.push(taskPromise);
            cleanupOwnedByTaskPromise = true;
          } finally {
            if (!cleanupOwnedByTaskPromise) {
              releaseOwnedResources();
            }
          }
        }
      } finally {
        // Preserve stage ordering even when setup for a later candidate rejects the lane.
        if (spawned.length > 0) {
          log.debug(
            { projectId, stage: stage.label, taskCount: spawned.length },
            "[FIX:149] Draining started stage tasks before lane exit",
          );
          await Promise.allSettled(spawned);
          log.debug(
            { projectId, stage: stage.label, taskCount: spawned.length },
            "[FIX:149] Started stage tasks drained",
          );
        }
      }
    }
  }

  const laneResults = await Promise.allSettled(
    projectIds.map((projectId) => processProjectLane(projectId)),
  );
  laneResults.forEach((result, index) => {
    if (result.status === "rejected") {
      log.error(
        { projectId: projectIds[index], err: result.reason },
        "Project coordinator lane failed",
      );
    }
  });

  log.debug("Poll cycle complete");
}

export function pollAndProcess(): Promise<void> {
  if (activePollPromise) {
    followUpPollRequested = true;
    log.debug("Poll cycle already active; queued one follow-up cycle");
    return activePollPromise;
  }

  async function drainPollRequests(): Promise<void> {
    do {
      followUpPollRequested = false;
      await runPollCycle();
    } while (followUpPollRequested);
  }

  activePollPromise = drainPollRequests().finally(() => {
    activePollPromise = null;
  });
  return activePollPromise;
}
