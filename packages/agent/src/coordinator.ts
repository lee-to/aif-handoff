import {
  findCoordinatorTaskCandidates,
  findProjectById,
  hasActiveLockedTaskForProject,
  claimTask,
  releaseTaskClaim,
  releaseStaleTaskClaims,
  updateTaskStatus as updateTaskStatusRow,
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
import { notifyTaskBroadcast, type TaskNotificationInfo } from "./notifier.js";
import { handleAutoReviewGate } from "./autoReviewHandler.js";
import { classifyStageError } from "./stageErrorHandler.js";
import { setActiveStageAbortController } from "./stageAbort.js";
import { setCoordinatorId } from "./subagentQuery.js";
import { releaseDueBlockedTasks, recoverStaleInProgressTasks } from "./taskWatchdog.js";

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

      if (outcome === "max_iterations_reached") {
        updateTaskStatus(task.id, "done", CLEAN_STATE_RESET, {
          title: taskTitle,
          fromStatus: stage.inProgress,
        });
        log.info(
          { taskId: task.id, from: stage.inProgress, to: "done" },
          "Auto review gate: max iterations reached, moving to done",
        );
        return true;
      }

      if (outcome === "rework_requested") {
        const currentCount = task.reviewIterationCount ?? 0;
        updateTaskStatus(
          task.id,
          "implementing",
          {
            ...CLEAN_STATE_RESET,
            reworkRequested: true,
            reviewIterationCount: currentCount + 1,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        log.info(
          {
            taskId: task.id,
            from: stage.inProgress,
            to: "implementing",
            reviewIteration: currentCount + 1,
          },
          "Auto review gate requested changes, restarting implementing stage",
        );
        return true;
      }
    }

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
        updateTaskStatus(
          task.id,
          "blocked_external",
          {
            blockedReason: err instanceof Error ? err.message : String(err),
            blockedFromStatus: stage.inProgress,
            retryAfter: recovery.retryAfter,
            retryCount: recovery.retryCount,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;

      case "revert":
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

    const candidates = findCoordinatorTaskCandidates(stage.label, available).filter(
      (t) => !failedInCycle.has(t.id),
    );

    if (candidates.length === 0) {
      log.debug({ stage: stage.label }, "No tasks to process");
      continue;
    }

    log.debug(
      { stage: stage.label, candidateCount: candidates.length, available },
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
