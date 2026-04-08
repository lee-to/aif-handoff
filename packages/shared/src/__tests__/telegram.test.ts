import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTelegramNotification } from "../telegram.js";

describe("sendTelegramNotification", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("uses the default Telegram API URL", async () => {
    delete process.env.TELEGRAM_BOT_API_URL;
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_USER_ID", "999");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await sendTelegramNotification({
      taskId: "task-default",
      title: "Default URL",
      fromStatus: "planning",
      toStatus: "plan_ready",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:ABC/sendMessage",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("uses TELEGRAM_BOT_API_URL when configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_API_URL", "https://telegram-proxy.invalid/");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_USER_ID", "999");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await sendTelegramNotification({
      taskId: "task-custom",
      title: "Custom URL",
      toStatus: "done",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram-proxy.invalid/bot123:ABC/sendMessage",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});
