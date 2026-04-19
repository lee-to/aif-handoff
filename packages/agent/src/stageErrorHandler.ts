/**
 * Stage error handler — classifies pipeline errors and applies
 * the appropriate recovery strategy (fast retry, backoff, or revert).
 * Extracted from coordinator.ts for single responsibility.
 */

import type { RuntimeLimitSnapshot } from "@aif/runtime";
import { logger, mapSafeRuntimeErrorReason, type TaskStatus } from "@aif/shared";
import { logActivity } from "./hooks.js";
import {
  findRuntimeExecutionError,
  isExternalFailure,
  isFastRetryableFailure,
  truncateReason,
} from "./errorClassifier.js";
import { getRandomBackoffMinutes } from "./taskWatchdog.js";

const log = logger("stage-error-handler");

type RetryAfterSource = "resetAt" | "retryAfterSeconds" | "random_backoff" | "none";

const NON_RETRYABLE_RUNTIME_CATEGORIES = new Set([
  "model_not_found",
  "context_length",
  "content_filter",
]);

export type ErrorRecovery =
  | { kind: "fast_retry" }
  | {
      kind: "blocked_external";
      blockedReason: string;
      retryAfter: string | null;
      retryAfterSource: RetryAfterSource;
      retryCount: number;
      limitSnapshot: RuntimeLimitSnapshot | null;
    }
  | { kind: "revert" };

interface StageErrorInput {
  taskId: string;
  stageLabel: string;
  sourceStatus: TaskStatus;
  retryCount: number;
  err: unknown;
}

function buildUserSafeExternalReason(err: unknown): string {
  const runtimeError = findRuntimeExecutionError(err);
  if (!runtimeError) {
    return "Runtime capability check failed. Check the configured runtime profile for this stage.";
  }

  switch (runtimeError.category) {
    case "rate_limit":
      return "Runtime usage limit reached. Task auto-paused until the retry window.";
    case "auth":
      return "Runtime authentication failed. Check the configured runtime profile.";
    case "permission":
      return "Runtime permissions blocked this task. Check the configured runtime profile or approval mode.";
    case "timeout":
      return "Runtime request timed out. Task will retry automatically.";
    case "stream":
      return "Runtime stream failed. Task will retry automatically.";
    case "transport":
    default:
      return "Runtime request failed. Task will retry automatically.";
  }
}

function resolveRetryAfter(err: unknown): {
  retryAfter: string;
  retryAfterSource: RetryAfterSource;
  backoffMinutes: number | null;
  limitSnapshot: RuntimeLimitSnapshot | null;
} {
  const runtimeError = findRuntimeExecutionError(err);
  const limitSnapshot = runtimeError?.limitSnapshot ?? null;

  if (runtimeError?.resetAt) {
    const resetAtMs = Date.parse(runtimeError.resetAt);
    if (Number.isFinite(resetAtMs)) {
      return {
        retryAfter: new Date(Math.max(resetAtMs, Date.now())).toISOString(),
        retryAfterSource: "resetAt",
        backoffMinutes: null,
        limitSnapshot,
      };
    }
  }

  if (
    typeof runtimeError?.retryAfterSeconds === "number" &&
    Number.isFinite(runtimeError.retryAfterSeconds) &&
    runtimeError.retryAfterSeconds >= 0
  ) {
    return {
      retryAfter: new Date(Date.now() + runtimeError.retryAfterSeconds * 1000).toISOString(),
      retryAfterSource: "retryAfterSeconds",
      backoffMinutes: null,
      limitSnapshot,
    };
  }

  const backoffMinutes = getRandomBackoffMinutes();
  return {
    retryAfter: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    retryAfterSource: "random_backoff",
    backoffMinutes,
    limitSnapshot,
  };
}

/**
 * Classify a stage error and return the recovery strategy + status fields.
 * The caller is responsible for applying the status update.
 */
export function classifyStageError(input: StageErrorInput): ErrorRecovery {
  const { taskId, stageLabel, sourceStatus, err } = input;
  const runtimeError = findRuntimeExecutionError(err);
  if (runtimeError && NON_RETRYABLE_RUNTIME_CATEGORIES.has(runtimeError.category)) {
    const safeReason = mapSafeRuntimeErrorReason(runtimeError);
    const blockedReason = `${safeReason.reason} Manual action required before retry.`;
    const limitSnapshot = runtimeError.limitSnapshot ?? null;

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        err,
        retryAfter: null,
        retryAfterSource: "none",
        runtimeCategory: runtimeError.category,
      },
      "Subagent failed with non-retryable runtime error, task requires manual action",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot,
    };
  }

  if (isFastRetryableFailure(err)) {
    const reason = err instanceof Error ? err.message : String(err);

    log.warn(
      { taskId, stage: stageLabel, reason },
      "Subagent hit transient stream interruption, scheduling fast retry",
    );

    return { kind: "fast_retry" };
  }

  if (isExternalFailure(err)) {
    const { retryAfter, retryAfterSource, backoffMinutes, limitSnapshot } = resolveRetryAfter(err);
    const reason = err instanceof Error ? err.message : String(err);
    const blockedReason = buildUserSafeExternalReason(err);
    const runtimeError = findRuntimeExecutionError(err);

    if (reason.trim() && reason.trim() !== blockedReason) {
      log.debug(
        {
          taskId,
          stage: stageLabel,
          safeReason: blockedReason,
          rawReason: reason,
        },
        "[FIX] Redacted raw runtime error before persisting blocked task state",
      );
    }

    if (retryAfterSource === "random_backoff") {
      log.warn(
        {
          taskId,
          stage: stageLabel,
          retryAfter,
          backoffMinutes,
          runtimeId: limitSnapshot?.runtimeId ?? null,
          providerId: limitSnapshot?.providerId ?? null,
          profileId: limitSnapshot?.profileId ?? null,
        },
        "Structured reset metadata missing for external error, falling back to random backoff",
      );
    }

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=${retryAfter}; source=${retryAfterSource}; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        err,
        retryAfter,
        retryAfterSource,
        backoffMinutes,
        runtimeId: limitSnapshot?.runtimeId ?? null,
        providerId: limitSnapshot?.providerId ?? null,
        profileId: limitSnapshot?.profileId ?? null,
        resetAt: runtimeError?.resetAt ?? null,
        retryAfterSeconds: runtimeError?.retryAfterSeconds ?? null,
      },
      "Subagent failed with external error, task blocked with backoff",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter,
      retryAfterSource,
      retryCount: (input.retryCount ?? 0) + 1,
      limitSnapshot,
    };
  }

  log.error({ taskId, stage: stageLabel, err }, "Subagent failed, reverting status");

  return { kind: "revert" };
}
