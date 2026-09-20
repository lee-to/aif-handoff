import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findProjectByTaskIdMock } = vi.hoisted(() => ({
  findProjectByTaskIdMock: vi.fn(),
}));

vi.mock("@aif/data", () => ({
  findProjectByTaskId: findProjectByTaskIdMock,
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    // Re-parse process env for each call so test-local vi.stubEnv overrides are visible.
    getEnv: () => actual.validateEnv(process.env),
  };
});

const { resetEnvCache } = await import("@aif/shared");
const { notifyTaskBroadcast } = await import("../notifier.js");

describe("notifyTaskBroadcast", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    findProjectByTaskIdMock.mockReset();
    resetEnvCache();
    vi.stubEnv("PORT", "3999");
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    resetEnvCache();
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

  it("sends internal auth headers for task broadcasts when INTERNAL_BROADCAST_TOKEN is configured", async () => {
    vi.stubEnv("INTERNAL_BROADCAST_TOKEN", "internal-token");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    await notifyTaskBroadcast("task-auth", "task:updated");

    const options = fetchMock.mock.calls[0][1];
    expect(options?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer internal-token",
      "X-Internal-Broadcast-Token": "internal-token",
    });
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

    it("resolves and renders the task project name", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");
      vi.stubEnv("AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED", "true");
      findProjectByTaskIdMock.mockReturnValue({ name: "Platform [Core]" });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-project", "task:moved", {
        title: "Fix login",
        fromStatus: "review",
        toStatus: "done",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(findProjectByTaskIdMock).toHaveBeenCalledWith("task-project");
      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      const body = JSON.parse(telegramCall![1].body);
      expect(body.text).toBe("📁 *Platform \\[Core\\]*\n📋 Fix login\nreview → done");
    });

    it("uses an explicit project name without querying the database", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");
      vi.stubEnv("AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED", "true");

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-explicit", "task:moved", {
        projectName: "Explicit Project",
        title: "Deploy",
        toStatus: "done",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(findProjectByTaskIdMock).not.toHaveBeenCalled();
      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      const body = JSON.parse(telegramCall![1].body);
      expect(body.text).toContain("📁 *Explicit Project*");
    });

    it("still sends Telegram when project lookup throws", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");
      vi.stubEnv("AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED", "true");
      findProjectByTaskIdMock.mockImplementation(() => {
        throw new Error("database unavailable");
      });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-lookup-error", "task:moved", {
        title: "Keep delivering",
        toStatus: "review",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(findProjectByTaskIdMock).toHaveBeenCalledWith("task-lookup-error");
      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      const body = JSON.parse(telegramCall![1].body);
      expect(body.text).toBe("📋 *Keep delivering*\nreview");
    });

    it("does not query the project while project names are disabled", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
      vi.stubEnv("TELEGRAM_USER_ID", "999");
      findProjectByTaskIdMock.mockReturnValue({ name: "Hidden Project" });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await notifyTaskBroadcast("task-disabled", "task:moved", {
        title: "Legacy title",
        toStatus: "done",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(findProjectByTaskIdMock).not.toHaveBeenCalled();
      const telegramCall = fetchMock.mock.calls.find(
        (call: any[]) => typeof call[0] === "string" && call[0].includes("api.telegram.org"),
      );
      const body = JSON.parse(telegramCall![1].body);
      expect(body.text).toBe("📋 *Legacy title*\ndone");
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
      expect(findProjectByTaskIdMock).not.toHaveBeenCalled();
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
