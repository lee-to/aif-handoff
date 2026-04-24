/**
 * Task watchdog — detects and recovers stale/blocked tasks.
 * Extracted from coordinator.ts for single responsibility.
 */

import {
  clearTaskRuntimeLimitSnapshot,
  listDueBlockedExternalTasks,
  listStaleInProgressTasks,
  setTaskFields,
} from "@aif/data";
import { logger, getEnv, type TaskStatus } from "@aif/shared";
import { logActivity } from "./hooks.js";
import { notifyTaskBroadcast } from "./notifier.js";

const log = logger("task-watchdog");
const env = getEnv();
const STALE_TIMEOUT_MS = Math.max(env.AGENT_STAGE_STALE_TIMEOUT_MS, 60_000);
const STALE_MAX_RETRY = Math.max(env.AGENT_STAGE_STALE_MAX_RETRY, 1);

export function getRandomBackoffMinutes(): number {
  return Math.floor(Math.random() * 11) + 5; // 5..15
}

function getResumeStatusForStaleTask(status: TaskStatus): TaskStatus {
  return status;
}

export function parseUpdatedAtMs(value: string): number | null {
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const normalized =
    !hasTimezone && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function releaseDueBlockedTasks(): void {
  const nowIso = new Date().toISOString();
  const blockedTasks = listDueBlockedExternalTasks(nowIso);

  log.debug({ candidateCount: blockedTasks.length }, "Due blocked tasks found for release");

  for (const task of blockedTasks) {
    if (!task.blockedFromStatus) continue;

    setTaskFields(task.id, {
      status: task.blockedFromStatus,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: 0,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    clearTaskRuntimeLimitSnapshot(task.id, nowIso);
    void notifyTaskBroadcast(task.id, "task:moved", {
      title: task.title,
      fromStatus: "blocked_external",
      toStatus: task.blockedFromStatus,
    });
    logActivity(
      task.id,
      "Agent",
      `coordinator released blocked_external -> ${task.blockedFromStatus} after retry window elapsed`,
    );

    log.info(
      { taskId: task.id, restoreTo: task.blockedFromStatus },
      "Task released from blocked_external after backoff",
    );
  }
}

export function recoverStaleInProgressTasks(): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const candidates = listStaleInProgressTasks();

  for (const task of candidates) {
    const heartbeatMs = task.lastHeartbeatAt ? parseUpdatedAtMs(task.lastHeartbeatAt) : null;
    const updatedAtMs = parseUpdatedAtMs(task.updatedAt);
    const referenceMs =
      heartbeatMs != null && updatedAtMs != null
        ? Math.max(heartbeatMs, updatedAtMs)
        : (heartbeatMs ?? updatedAtMs);
    if (referenceMs == null) continue;

    const ageMs = now - referenceMs;
    if (ageMs < STALE_TIMEOUT_MS) continue;

    const retryCount = task.retryCount ?? 0;
    const resumeStatus = getResumeStatusForStaleTask(task.status);
    const ageMinutes = Math.floor(ageMs / 60_000);
    const reasonBase = `Watchdog: task stale in ${task.status} for ${ageMinutes}m`;

    if (retryCount >= STALE_MAX_RETRY) {
      setTaskFields(task.id, {
        status: "blocked_external",
        blockedReason: `${reasonBase}; auto-retry limit reached (${STALE_MAX_RETRY})`,
        blockedFromStatus: resumeStatus,
        retryAfter: null,
        lastHeartbeatAt: nowIso,
        updatedAt: nowIso,
      });
      clearTaskRuntimeLimitSnapshot(task.id, nowIso);
      void notifyTaskBroadcast(task.id, "task:moved", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "blocked_external",
      });
      logActivity(
        task.id,
        "Agent",
        `coordinator moved to blocked_external (watchdog max retry reached, resume=${resumeStatus})`,
      );

      log.error(
        { taskId: task.id, status: task.status, retryCount, staleMinutes: ageMinutes },
        "Task quarantined by stale watchdog after max retries",
      );
      continue;
    }

    const backoffMinutes = getRandomBackoffMinutes();
    const retryAfter = new Date(now + backoffMinutes * 60_000).toISOString();
    setTaskFields(task.id, {
      status: "blocked_external",
      blockedReason: `${reasonBase}; auto-recover scheduled`,
      blockedFromStatus: resumeStatus,
      retryAfter,
      retryCount: retryCount + 1,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    clearTaskRuntimeLimitSnapshot(task.id, nowIso);
    void notifyTaskBroadcast(task.id, "task:moved", {
      title: task.title,
      fromStatus: task.status,
      toStatus: "blocked_external",
    });
    logActivity(
      task.id,
      "Agent",
      `coordinator moved to blocked_external (watchdog stale recovery, resume=${resumeStatus}, retryAfter=${retryAfter})`,
    );

    log.warn(
      {
        taskId: task.id,
        status: task.status,
        staleMinutes: ageMinutes,
        retryAfter,
        nextStatus: resumeStatus,
        retryCount: retryCount + 1,
      },
      "Task recovered by stale watchdog",
    );
  }
}
