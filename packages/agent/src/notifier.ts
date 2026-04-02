import { logger, getEnv, sendTelegramNotification } from "@aif/shared";

const log = logger("agent-notifier");

type BroadcastType = "task:updated" | "task:moved";

export interface TaskNotificationInfo {
  title?: string;
  fromStatus?: string;
  toStatus?: string;
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
  // Skip when status didn't actually change (e.g. implementing → implementing).
  if (type === "task:moved" && (!info.fromStatus || info.fromStatus !== info.toStatus)) {
    void sendTelegramNotification({
      taskId,
      title: info.title,
      fromStatus: info.fromStatus,
      toStatus: info.toStatus,
    });
  }
}
