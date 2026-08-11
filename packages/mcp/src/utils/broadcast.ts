import { findProjectByTaskId } from "@aif/data";
import { getEnv, logger, sendTelegramNotification } from "@aif/shared";

const log = logger("mcp:broadcast");

export interface BroadcastOptions {
  projectName?: string;
  title?: string;
  fromStatus?: string;
  toStatus?: string;
}

/**
 * Best-effort WS broadcast via API endpoint + Telegram notification.
 * MCP tools call this after mutating task state so the UI updates in real-time.
 */
export async function broadcastTaskChange(
  taskId: string,
  type: "task:moved" | "task:updated" = "task:updated",
  options: BroadcastOptions = {},
): Promise<void> {
  const baseUrl = getEnv().API_BASE_URL;
  const url = `${baseUrl}/tasks/${taskId}/broadcast`;

  try {
    const internalToken = getEnv().INTERNAL_BROADCAST_TOKEN?.trim();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(internalToken ? { "X-Internal-Broadcast-Token": internalToken } : {}),
      },
      body: JSON.stringify({ type }),
    });

    if (res.ok) {
      log.info({ taskId, type }, "Task broadcast sent");
    } else {
      log.warn({ taskId, type, status: res.status }, "Task broadcast returned non-OK");
    }
  } catch (err) {
    log.warn({ taskId, type, err }, "Task broadcast request failed");
  }

  // Best-effort Telegram — only for actual status changes
  if (type === "task:moved" && (!options.fromStatus || options.fromStatus !== options.toStatus)) {
    void sendTelegramNotification({
      taskId,
      projectName: options.projectName,
      resolveProjectName: () => findProjectByTaskId(taskId)?.name,
      title: options.title,
      fromStatus: options.fromStatus,
      toStatus: options.toStatus,
    });
  }
}
