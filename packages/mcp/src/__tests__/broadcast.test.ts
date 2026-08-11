import { describe, it, expect, vi, beforeEach } from "vitest";

const { findProjectByTaskIdMock, sendTelegramNotificationMock } = vi.hoisted(() => ({
  findProjectByTaskIdMock: vi.fn(),
  sendTelegramNotificationMock: vi.fn(async () => undefined),
}));

vi.mock("@aif/data", () => ({
  findProjectByTaskId: findProjectByTaskIdMock,
}));

// Mock getEnv before importing the module under test.
// Also mock sendTelegramNotification as a no-op since the top-level mock has no tokens.
vi.mock("@aif/shared", async () => {
  const actual = await vi.importActual<typeof import("@aif/shared")>("@aif/shared");
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_USER_ID: undefined,
    }),
    // No-op: tokens are not configured in this mock scope
    sendTelegramNotification: sendTelegramNotificationMock,
  };
});

import { broadcastTaskChange } from "../utils/broadcast.js";

describe("broadcastTaskChange", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    findProjectByTaskIdMock.mockReset();
    sendTelegramNotificationMock.mockReset();
    sendTelegramNotificationMock.mockResolvedValue(undefined);
  });

  it("sends POST to broadcast endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcastTaskChange("task-abc", "task:moved");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3009/tasks/task-abc/broadcast",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("task:moved");
  });

  it("defaults type to task:updated", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcastTaskChange("task-abc");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("task:updated");
  });

  it("handles non-OK response without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(broadcastTaskChange("task-abc", "task:moved")).resolves.toBeUndefined();
  });

  it("handles fetch errors without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(broadcastTaskChange("task-abc")).resolves.toBeUndefined();
  });

  it("defers the project lookup to the Telegram sender", async () => {
    findProjectByTaskIdMock.mockReturnValue({ name: "MCP Project" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await broadcastTaskChange("task-project", "task:moved", {
      title: "Sync status",
      fromStatus: "planning",
      toStatus: "plan_ready",
    });

    expect(findProjectByTaskIdMock).not.toHaveBeenCalled();
    expect(sendTelegramNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-project",
        resolveProjectName: expect.any(Function),
      }),
    );
    const notification = sendTelegramNotificationMock.mock.calls[0][0];
    expect(notification.resolveProjectName()).toBe("MCP Project");
    expect(findProjectByTaskIdMock).toHaveBeenCalledWith("task-project");
  });

  it("uses an explicit project name without querying the database", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await broadcastTaskChange("task-explicit", "task:moved", {
      projectName: "Explicit MCP Project",
      title: "Sync status",
      toStatus: "done",
    });

    expect(findProjectByTaskIdMock).not.toHaveBeenCalled();
    expect(sendTelegramNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "Explicit MCP Project" }),
    );
  });
});

describe("broadcastTaskChange with Telegram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    findProjectByTaskIdMock.mockReset();
  });

  it("sends Telegram notification on task:moved with status change", async () => {
    const tgEnv = {
      API_BASE_URL: "http://localhost:3009",
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_USER_ID: "12345",
    };
    vi.doMock("@aif/shared", async () => {
      const actual = await vi.importActual<typeof import("@aif/shared")>("@aif/shared");
      return {
        ...actual,
        getEnv: () => tgEnv,
        // Re-bind so sendTelegramNotification sees the mocked env tokens
        sendTelegramNotification: async (options: {
          taskId: string;
          projectName?: string;
          title?: string;
          fromStatus?: string;
          toStatus?: string;
        }) => {
          const botToken = tgEnv.TELEGRAM_BOT_TOKEN;
          const userId = tgEnv.TELEGRAM_USER_ID;
          if (!botToken || !userId) return;
          const esc = (t: string) => t.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
          const displayTitle = options.title ?? options.taskId.slice(0, 8);
          const transition =
            options.fromStatus && options.toStatus
              ? `${options.fromStatus} → ${options.toStatus}`
              : (options.toStatus ?? "updated");
          const escapedTitle = esc(displayTitle);
          const text = options.projectName
            ? `📁 *${esc(options.projectName)}*\n📋 ${escapedTitle}\n${esc(transition)}`
            : `📋 *${escapedTitle}*\n${esc(transition)}`;
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: userId, text, parse_mode: "MarkdownV2" }),
          });
        },
      };
    });

    const { broadcastTaskChange: broadcast } = await import("../utils/broadcast.js");

    const calls: Array<{ url: string; body: string }> = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string });
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("fetch", mockFetch);

    await broadcast("task-abc", "task:moved", {
      title: "My task",
      fromStatus: "planning",
      toStatus: "plan_ready",
    });

    // Wait for fire-and-forget Telegram call
    await new Promise((r) => setTimeout(r, 50));

    // First call is broadcast, second is Telegram
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("http://localhost:3009/tasks/task-abc/broadcast");
    expect(calls[1].url).toContain("api.telegram.org/bottest-bot-token/sendMessage");

    const tgBody = JSON.parse(calls[1].body);
    expect(tgBody.chat_id).toBe("12345");
    expect(tgBody.text).toContain("My task");
    expect(tgBody.text).toContain("plan\\_ready");
  });

  it("uses the internal broadcast credential without putting it in the body", async () => {
    vi.doMock("@aif/shared", async () => {
      const actual = await vi.importActual<typeof import("@aif/shared")>("@aif/shared");
      return {
        ...actual,
        getEnv: () => ({
          API_BASE_URL: "http://localhost:3009",
          INTERNAL_BROADCAST_TOKEN: "internal-broadcast-secret",
        }),
        sendTelegramNotification: async () => {},
      };
    });
    const { broadcastTaskChange: broadcast } = await import("../utils/broadcast.js");
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcast("task-abc");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3009/tasks/task-abc/broadcast",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Broadcast-Token": "internal-broadcast-secret",
        },
      }),
    );
    expect(mockFetch.mock.calls[0][1].body).not.toContain("internal-broadcast-secret");
  });

  it("skips Telegram when fromStatus equals toStatus", async () => {
    vi.doMock("@aif/shared", async () => {
      const actual = await vi.importActual<typeof import("@aif/shared")>("@aif/shared");
      return {
        ...actual,
        getEnv: () => ({
          API_BASE_URL: "http://localhost:3009",
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_USER_ID: "12345",
        }),
      };
    });

    const { broadcastTaskChange: broadcast } = await import("../utils/broadcast.js");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcast("task-abc", "task:moved", {
      fromStatus: "planning",
      toStatus: "planning",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Only broadcast call, no Telegram
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/broadcast");
  });

  it("skips Telegram for task:updated type", async () => {
    vi.doMock("@aif/shared", async () => {
      const actual = await vi.importActual<typeof import("@aif/shared")>("@aif/shared");
      return {
        ...actual,
        getEnv: () => ({
          API_BASE_URL: "http://localhost:3009",
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_USER_ID: "12345",
        }),
      };
    });

    const { broadcastTaskChange: broadcast } = await import("../utils/broadcast.js");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcast("task-abc", "task:updated", {
      fromStatus: "planning",
      toStatus: "plan_ready",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Only broadcast call, no Telegram
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("skips Telegram when tokens are not configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    // Uses the top-level mock (no tokens)
    await broadcastTaskChange("task-abc", "task:moved", {
      fromStatus: "planning",
      toStatus: "plan_ready",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Only broadcast, no Telegram
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
