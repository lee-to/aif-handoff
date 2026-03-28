import {
  findCoordinatorTaskCandidate,
  findProjectById,
  updateTaskStatus as updateTaskStatusRow,
  type TaskFieldsPatch,
} from "@aif/data";
import {
  logger,
  initProjectDirectory,
  getEnv,
  CLEAN_STATE_RESET,
  withTimeout,
  type TaskStatus,
} from "@aif/shared";
import { runPlanner } from "./subagents/planner.js";
import { runPlanChecker } from "./subagents/planChecker.js";
import { runImplementer } from "./subagents/implementer.js";
import { runReviewer } from "./subagents/reviewer.js";
import { flushActivityQueue } from "./hooks.js";
import { notifyTaskBroadcast } from "./notifier.js";
import { handleAutoReviewGate } from "./autoReviewHandler.js";
import { classifyStageError } from "./stageErrorHandler.js";
import { releaseDueBlockedTasks, recoverStaleInProgressTasks } from "./taskWatchdog.js";

const log = logger("coordinator");
const env = getEnv();
const STAGE_RUN_TIMEOUT_MS = Math.max(env.AGENT_STAGE_RUN_TIMEOUT_MS, 60_000);

const runtimeCounters = {
  fastRetryStreamInterruptions: 0,
};

interface StatusTransition {
  from: TaskStatus[];
  inProgress: TaskStatus;
  onSuccess: TaskStatus;
  runner: (taskId: string, projectRoot: string) => Promise<void>;
  label: string;
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

export function getCoordinatorRuntimeCounters(): Readonly<typeof runtimeCounters> {
  return { ...runtimeCounters };
}

export function resetCoordinatorRuntimeCountersForTests(): void {
  runtimeCounters.fastRetryStreamInterruptions = 0;
}

async function runStageWithTimeout(
  runner: (taskId: string, projectRoot: string) => Promise<void>,
  taskId: string,
  projectRoot: string,
  stageLabel: string,
): Promise<void> {
  await withTimeout(
    runner(taskId, projectRoot),
    STAGE_RUN_TIMEOUT_MS,
    `Stage ${stageLabel} timed out after ${STAGE_RUN_TIMEOUT_MS}ms`,
  );
}

/** Update task status with optional field overrides and broadcast. */
function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: Omit<TaskFieldsPatch, "status" | "lastHeartbeatAt" | "updatedAt"> = {},
): void {
  updateTaskStatusRow(taskId, status, extra);
  void notifyTaskBroadcast(taskId, "task:moved");
}

export async function pollAndProcess(): Promise<void> {
  log.debug("Starting poll cycle");
  releaseDueBlockedTasks();
  recoverStaleInProgressTasks();

  for (const stage of PIPELINE) {
    const task = findCoordinatorTaskCandidate(stage.label);

    if (!task) {
      log.debug({ stage: stage.label }, "No tasks to process");
      continue;
    }

    log.debug(
      { stage: stage.label, taskId: task.id, candidateStatus: task.status },
      "Task candidate selected",
    );

    const project = findProjectById(task.projectId);

    if (!project) {
      log.error(
        { taskId: task.id, projectId: task.projectId },
        "Project not found for task, skipping",
      );
      continue;
    }

    initProjectDirectory(project.rootPath);

    log.info(
      { taskId: task.id, title: task.title, stage: stage.label, projectRoot: project.rootPath },
      "Picked up task for processing",
    );
    const sourceStatus = task.status;

    updateTaskStatus(task.id, stage.inProgress);

    log.debug(
      { taskId: task.id, from: sourceStatus, to: stage.inProgress },
      "Status transition (start)",
    );

    try {
      await runStageWithTimeout(stage.runner, task.id, project.rootPath, stage.label);

      flushActivityQueue(task.id);

      // Auto review gate: after reviewer in autoMode, decide accept vs rework
      if (stage.label === "reviewer") {
        const outcome = await handleAutoReviewGate({
          taskId: task.id,
          projectRoot: project.rootPath,
        });

        if (outcome === "rework_requested") {
          updateTaskStatus(task.id, "implementing", {
            ...CLEAN_STATE_RESET,
            reworkRequested: true,
          });

          log.info(
            { taskId: task.id, from: stage.inProgress, to: "implementing" },
            "Auto review gate requested changes, restarting implementing stage",
          );
          continue;
        }
      }

      updateTaskStatus(task.id, stage.onSuccess, CLEAN_STATE_RESET);

      log.info(
        { taskId: task.id, from: stage.inProgress, to: stage.onSuccess },
        "Status transition (success)",
      );
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
          updateTaskStatus(task.id, sourceStatus, {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
          });
          break;

        case "blocked_external":
          updateTaskStatus(task.id, "blocked_external", {
            blockedReason: err instanceof Error ? err.message : String(err),
            blockedFromStatus: sourceStatus,
            retryAfter: recovery.retryAfter,
            retryCount: recovery.retryCount,
          });
          break;

        case "revert":
          updateTaskStatus(task.id, sourceStatus);
          break;
      }

      flushActivityQueue(task.id);

      // Stop current poll cycle after a failed stage to avoid immediately
      // re-picking the same task in a downstream stage in this same cycle.
      break;
    }
  }

  log.debug("Poll cycle complete");
}
