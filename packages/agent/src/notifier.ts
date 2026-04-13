import { logger, getEnv, sendTelegramNotification } from "@aif/shared";

const log = logger("agent-notifier");

type BroadcastType = "task:updated" | "task:moved" | "task:activity" | "task:scheduled_fired";

export interface TaskNotificationInfo {
  title?: string;
  fromStatus?: string;
  toStatus?: string;
}

type ProjectBroadcastType = "project:auto_queue_mode_changed" | "project:auto_queue_advanced";

/** Best-effort project-scoped WS broadcast via the API. */
export async function notifyProjectBroadcast(
  projectId: string,
  type: ProjectBroadcastType,
  info: { taskId?: string } = {},
): Promise<void> {
  const baseUrl = getEnv().API_BASE_URL;
  const url = `${baseUrl}/projects/${projectId}/broadcast`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, taskId: info.taskId }),
    });
    if (res.ok) {
      log.info({ projectId, type, taskId: info.taskId }, "Project broadcast sent");
    } else {
      log.warn(
        { projectId, type, status: res.status, url },
        "Project broadcast request returned non-OK status",
      );
    }
  } catch (err) {
    log.warn({ projectId, type, err, url }, "Project broadcast request failed");
  }
}

export async function notifyTaskBroadcast(
  taskId: string,
  type: BroadcastType = "task:updated",
  info: TaskNotificationInfo = {},
): Promise<void> {
  const baseUrl = getEnv().API_BASE_URL;
  const url = `${baseUrl}/tasks/${taskId}/broadcast`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });

    if (res.ok) {
      log.info({ taskId, type, toStatus: info.toStatus }, "Task broadcast sent");
    } else {
      log.warn(
        { taskId, type, status: res.status, url },
        "Task broadcast request returned non-OK status",
      );
    }
  } catch (err) {
    // Broadcast is best-effort. Agent processing must not fail because API is unavailable.
    log.warn({ taskId, type, err, url }, "Task broadcast request failed");
  }

  // Best-effort Telegram notification — fire and forget.
  // Skip Telegram for activity-only broadcasts (too noisy).
  // Skip for scheduled-fire events (the follow-up task:moved carries richer info).
  // Skip when status didn't actually change (e.g. implementing → implementing).
  if (type === "task:activity" || type === "task:scheduled_fired") return;
  if (type === "task:moved" && (!info.fromStatus || info.fromStatus !== info.toStatus)) {
    void sendTelegramNotification({
      taskId,
      title: info.title,
      fromStatus: info.fromStatus,
      toStatus: info.toStatus,
    });
  }
}
