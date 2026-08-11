import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../env.js";
import { sendTelegramNotification } from "../telegram.js";

describe("sendTelegramNotification", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    resetEnvCache();
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

  it("renders an escaped project name before a plain task title", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_USER_ID", "999");
    vi.stubEnv("AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED", "true");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await sendTelegramNotification({
      taskId: "task-project",
      projectName: "Platform [Core]",
      title: "Fix login (redirect)",
      fromStatus: "review",
      toStatus: "done",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe("📁 *Platform \\[Core\\]*\n📋 Fix login \\(redirect\\)\nreview → done");
  });

  it("keeps project names disabled by default", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_USER_ID", "999");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await sendTelegramNotification({
      taskId: "task-disabled",
      projectName: "Hidden Project",
      title: "Legacy title",
      toStatus: "done",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe("📋 *Legacy title*\ndone");
  });

  it("keeps the existing message shape when the project is unavailable", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_USER_ID", "999");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await sendTelegramNotification({
      taskId: "task-legacy",
      title: "Legacy title",
      toStatus: "done",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe("📋 *Legacy title*\ndone");
  });
});
