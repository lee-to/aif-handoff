import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyTaskBroadcast } from "../notifier.js";

describe("notifyTaskBroadcast", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("PORT", "3999");
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("sends broadcast request with provided type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    await notifyTaskBroadcast("task-1", "task:moved");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/tasks/task-1/broadcast",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses default event type when omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    await notifyTaskBroadcast("task-2");

    const options = fetchMock.mock.calls[0][1];
    expect(typeof options?.body).toBe("string");
    expect(options?.body).toContain("task:updated");
  });

  it("does not throw on failed fetch", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as any;

    await expect(notifyTaskBroadcast("task-3", "task:updated")).resolves.toBeUndefined();
  });

  describe("telegram notifications", () => {
    it("sends Telegram message on task:moved when env is configured", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-tg", "task:moved", {
        title: "My Task",
        fromStatus: "planning",
        toStatus: "plan_ready",
      });

      // Wait a tick for the fire-and-forget void call to resolve
      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );

      expect(telegramCall).toBeDefined();
      expect(telegramCall![0]).toBe("https://api.telegram.org/bot123:ABC/sendMessage");

      const body = JSON.parse(telegramCall![1].body);
      expect(body.chat_id).toBe("999");
      expect(body.parse_mode).toBe("MarkdownV2");
      expect(body.text).toContain("My Task");
      expect(body.text).toContain("planning");
      expect(body.text).toContain("plan\\_ready");
    });

    it("does not send Telegram message when env is not configured", async () => {
      // Explicitly clear tokens that may exist in the real environment
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      vi.stubEnv("TELEGRAM_USER_ID", "");
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-no-tg", "task:moved", {
        title: "Some Task",
        toStatus: "done",
      });

      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      expect(telegramCall).toBeUndefined();
    });

    it("does not send Telegram message on task:updated (only task:moved)", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-upd", "task:updated", {
        title: "Updated Task",
        toStatus: "implementing",
      });

      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      expect(telegramCall).toBeUndefined();
    });

    it("does not throw when Telegram request fails", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (url.includes("api.telegram.org")) {
          return Promise.reject(new Error("telegram down"));
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      global.fetch = fetchMock as any;

      await expect(
        notifyTaskBroadcast("task-tg-err", "task:moved", { title: "Fail Task" }),
      ).resolves.toBeUndefined();

      await new Promise((r) => setTimeout(r, 10));

      // Broadcast call + Telegram call should both have been attempted
      expect(callCount).toBe(2);
    });

    it("uses taskId as fallback title and 'updated' as fallback transition", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("abc-123", "task:moved", {});

      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      expect(telegramCall).toBeDefined();

      const body = JSON.parse(telegramCall![1].body);
      expect(body.text).toContain("abc\\-123");
      expect(body.text).toContain("updated");
    });

    it("skips Telegram when fromStatus equals toStatus (no real change)", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-noop", "task:moved", {
        title: "Same Status",
        fromStatus: "implementing",
        toStatus: "implementing",
      });

      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      expect(telegramCall).toBeUndefined();
    });

    it("escapes MarkdownV2 special characters in title", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-esc", "task:moved", {
        title: "Fix bug [critical] (prod)",
        toStatus: "done",
      });

      await new Promise((r) => setTimeout(r, 10));

      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      const body = JSON.parse(telegramCall![1].body);
      // Square brackets and parens must be escaped
      expect(body.text).toContain("\\[critical\\]");
      expect(body.text).toContain("\\(prod\\)");
    });
  });
});
