import { logger } from "./logger.js";

const log = logger("telegram");

/**
 * Escape special characters for Telegram MarkdownV2 parse mode.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export interface TelegramNotificationOptions {
  taskId: string;
  title?: string;
  fromStatus?: string;
  toStatus?: string;
}

/**
 * Send a best-effort Telegram notification for a task status change.
 * Returns silently if TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID are not configured.
 *
 * Reads tokens directly from process.env at call time (not via the cached getEnv())
 * so that test stubs (vi.stubEnv) are respected and so that optional Telegram config
 * doesn't force a full environment validation.
 */
export async function sendTelegramNotification(
  options: TelegramNotificationOptions,
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;
  if (!botToken || !userId) return;

  const displayTitle = options.title ?? options.taskId.slice(0, 8);
  const transition =
    options.fromStatus && options.toStatus
      ? `${options.fromStatus} → ${options.toStatus}`
      : (options.toStatus ?? "updated");

  const text = `📋 *${escapeMarkdown(displayTitle)}*\n${escapeMarkdown(transition)}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: userId, text, parse_mode: "MarkdownV2" }),
    });

    if (!res.ok) {
      log.debug({ taskId: options.taskId, status: res.status }, "Telegram notification failed");
    }
  } catch (err) {
    log.debug({ taskId: options.taskId, err }, "Telegram notification request failed");
  }
}
