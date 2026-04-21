import {
  clearTaskRuntimeLimitSnapshot,
  blockTaskForRuntimeGateIfEligible,
  evaluateRuntimeLimitGate,
  findCoordinatorTaskCandidates,
  findProjectById,
  hasActiveLockedTaskForProject,
  claimTask,
  releaseTaskClaim,
  releaseStaleTaskClaims,
  updateTaskStatus as updateTaskStatusRow,
  listDueScheduledTasks,
  appendTaskActivityLog,
  listAutoQueueProjects,
  nextBacklogTaskByPosition,
  countActivePipelineTasksForProject,
  claimBacklogTaskForAdvance,
  persistTaskRuntimeLimitSnapshot,
  resolveEffectiveRuntimeProfile,
  type CoordinatorStage,
  type TaskFieldsPatch,
  type TaskRow,
} from "@aif/data";
import { initProject, type RuntimeRegistry } from "@aif/runtime";
import { logger, getEnv, CLEAN_STATE_RESET, withTimeout, type TaskStatus } from "@aif/shared";
import { runPlanner } from "./subagents/planner.js";
import { runPlanChecker } from "./subagents/planChecker.js";
import { runImplementer } from "./subagents/implementer.js";
import { runReviewer } from "./subagents/reviewer.js";
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
import {
  getRandomBackoffMinutes,
  releaseDueBlockedTasks,
  recoverStaleInProgressTasks,
} from "./taskWatchdog.js";

const log = logger("coordinator");
const env = getEnv();
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

  tryAcquire(stage: string, max: number): boolean {
    const current = this.counts.get(stage) ?? 0;
    if (current >= max) return false;
    this.counts.set(stage, current + 1);
    return true;
  }

  release(stage: string): void {
    const current = this.counts.get(stage) ?? 0;
    this.counts.set(stage, Math.max(0, current - 1));
  }

  available(stage: string, max: number): number {
    return max - (this.counts.get(stage) ?? 0);
  }

  totalActive(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  reset(): void {
    this.counts.clear();
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

function runtimeProfileModeForStage(stage: CoordinatorStage): "task" | "plan" | "review" {
  if (stage === "planner" || stage === "plan-checker") {
    return "plan";
  }
  if (stage === "reviewer") {
    return "review";
  }
  return "task";
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
    const initResult = initProject({ projectRoot: project.rootPath, registry: _runtimeRegistry });
    if (!initResult.ok) {
      log.error(
        { taskId: task.id, projectId: task.projectId, error: initResult.error },
        "Project .ai-factory/ scaffold missing and init failed, skipping task",
      );
      return false;
    }
  }

  log.info(
    { taskId: task.id, title: task.title, stage: stage.label, projectRoot: project.rootPath },
    "Picked up task for processing",
  );
  const sourceStatus = task.status;
  const taskTitle = task.title;

  updateTaskStatus(task.id, stage.inProgress, {}, { title: taskTitle, fromStatus: sourceStatus });

  log.debug(
    { taskId: task.id, from: sourceStatus, to: stage.inProgress },
    "Status transition (start)",
  );

  try {
    await runStageWithTimeout(stage.runner, task.id, project.rootPath, stage.label);

    flushActivityQueue(task.id);

    if (stage.label === "implementer" && task.skipReview) {
      clearTaskRuntimeLimitSnapshot(task.id);
      updateTaskStatus(task.id, "done", CLEAN_STATE_RESET, {
        title: taskTitle,
        fromStatus: stage.inProgress,
      });
      log.info(
        { taskId: task.id, from: stage.inProgress, to: "done" },
        "Skip review enabled — bypassing review stage",
      );
      return true;
    }

    if (stage.label === "reviewer") {
      const outcome = await handleAutoReviewGate({
        taskId: task.id,
        projectRoot: project.rootPath,
      });

      if (outcome?.status === "manual_review_required") {
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

    clearTaskRuntimeLimitSnapshot(task.id);
    updateTaskStatus(
      task.id,
      stage.onSuccess,
      {
        ...CLEAN_STATE_RESET,
        reviewIterationCount: stage.label === "implementer" ? (task.reviewIterationCount ?? 0) : 0,
      },
      { title: taskTitle, fromStatus: stage.inProgress },
    );

    log.info(
      { taskId: task.id, from: stage.inProgress, to: stage.onSuccess },
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
      // CAS-style claim: only proceed if the row is still backlog+unpaused
      // at the moment of the write. Prevents racing with auto-queue or with
      // a parallel coordinator instance.
      if (!claimBacklogTaskForAdvance(task.id)) {
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
 * `COORDINATOR_MAX_CONCURRENT_TASKS` for parallel projects, so the same
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
    const limit = project.parallelEnabled ? env.COORDINATOR_MAX_CONCURRENT_TASKS : 1;
    let active = countActivePipelineTasksForProject(project.id);

    if (active >= limit) {
      log.debug(
        { projectId: project.id, active, limit },
        "Auto-queue: project pipeline at capacity, skipping",
      );
      continue;
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
        if (!claimBacklogTaskForAdvance(next.id)) {
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

export async function pollAndProcess(): Promise<void> {
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

  const globalMax = env.COORDINATOR_MAX_CONCURRENT_TASKS;

  // Track tasks that failed in this cycle — prevent re-picking in downstream stages
  const failedInCycle = new Set<string>();

  // Cache project parallel settings to avoid repeated lookups
  const projectParallelCache = new Map<string, boolean>();
  function isProjectParallel(projectId: string): boolean {
    let cached = projectParallelCache.get(projectId);
    if (cached === undefined) {
      const project = findProjectById(projectId);
      cached = project?.parallelEnabled ?? false;
      projectParallelCache.set(projectId, cached);
    }
    return cached;
  }

  for (const stage of PIPELINE) {
    // Global cap: total active tasks across all stages (prevents resource exhaustion
    // when multiple poll cycles overlap from cron + wake)
    const totalActive = stageSemaphore.totalActive();
    if (totalActive >= globalMax) {
      log.debug(
        { stage: stage.label, totalActive, globalMax },
        "Global task limit reached, skipping stage",
      );
      continue;
    }

    // Per-project spawn count scoped to this stage (stages are sequential via allSettled)
    const projectSpawnCount = new Map<string, number>();

    const availableInStage = stageSemaphore.available(stage.label, globalMax);
    const availableGlobal = globalMax - totalActive;
    const available = Math.min(availableInStage, availableGlobal);
    if (available <= 0) {
      log.debug({ stage: stage.label }, "Stage at capacity, skipping");
      continue;
    }

    const candidateWindow = Math.min(Math.max(available * 5, available), 50);
    const candidates = findCoordinatorTaskCandidates(stage.label, candidateWindow).filter(
      (t) => !failedInCycle.has(t.id),
    );

    if (candidates.length === 0) {
      log.debug({ stage: stage.label }, "No tasks to process");
      continue;
    }

    log.debug(
      {
        stage: stage.label,
        candidateCount: candidates.length,
        candidateWindow,
        available,
      },
      "Task candidates selected",
    );

    const spawned: Promise<void>[] = [];

    for (const task of candidates) {
      // Per-project concurrency: non-parallel projects limited to 1 task at a time
      const parallel = isProjectParallel(task.projectId);
      const projectMax = parallel ? globalMax : 1;
      const projectCount = projectSpawnCount.get(task.projectId) ?? 0;
      if (projectCount >= projectMax) {
        log.debug(
          { taskId: task.id, projectId: task.projectId },
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

      const runtimeSelection = resolveEffectiveRuntimeProfile({
        taskId: task.id,
        projectId: task.projectId,
        mode: runtimeProfileModeForStage(stage.label),
      });
      const gateDecision = evaluateRuntimeLimitGate(runtimeSelection.profile);
      if (gateDecision.blocked) {
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
        continue;
      }

      if (!claimTask(task.id, COORDINATOR_ID, CLAIM_LOCK_DURATION_MS)) {
        log.debug({ taskId: task.id, stage: stage.label }, "Task claim failed (already claimed)");
        continue;
      }

      if (
        stageSemaphore.totalActive() >= globalMax ||
        !stageSemaphore.tryAcquire(stage.label, globalMax)
      ) {
        releaseTaskClaim(task.id);
        log.debug({ stage: stage.label }, "Semaphore full after claim");
        break;
      }

      projectSpawnCount.set(task.projectId, projectCount + 1);

      log.debug(
        { stage: stage.label, taskId: task.id, candidateStatus: task.status, parallel },
        "Task claimed for processing",
      );

      const taskPromise = processOneTask(task, stage)
        .then((success) => {
          if (!success) failedInCycle.add(task.id);
        })
        .catch((err) => {
          failedInCycle.add(task.id);
          log.error(
            { taskId: task.id, stage: stage.label, err },
            "Unexpected error in task processing",
          );
        })
        .finally(() => {
          stageSemaphore.release(stage.label);
          releaseTaskClaim(task.id);
        });

      spawned.push(taskPromise);
    }

    // Within-stage parallelism: await all tasks in this stage before moving to next
    if (spawned.length > 0) {
      await Promise.allSettled(spawned);
    }
  }

  log.debug("Poll cycle complete");
}
