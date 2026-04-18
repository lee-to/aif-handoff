import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const readdirMock = vi.fn();
const readFileMock = vi.fn();
const statMock = vi.fn();

vi.mock("node:os", () => ({
  homedir: () => "C:/Users/test",
}));

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
}));

function dirEntry(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  };
}

function fileEntry(name: string) {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
  };
}

type SessionsModule = typeof import("../adapters/codex/sessions.js");

describe("Codex SDK session store parsing", () => {
  const sessionsRoot = join("C:/Users/test", ".codex", "sessions");
  const authFile = join("C:/Users/test", ".codex", "auth.json");
  const aprilDir = join(sessionsRoot, "2026", "04", "08");
  const olderSessionId = "019d6e29-f6a5-7991-b695-0ac84756e40f";
  const newerSessionId = "019d6e2c-e143-7642-8917-06f51e30ee84";
  const olderFile = join(aprilDir, `rollout-2026-04-08T22-35-37-${olderSessionId}.jsonl`);
  const newerFile = join(aprilDir, `rollout-2026-04-08T22-38-48-${newerSessionId}.jsonl`);

  let sessionsModule: SessionsModule;

  beforeEach(async () => {
    vi.resetModules();
    readdirMock.mockReset();
    readFileMock.mockReset();
    statMock.mockReset();

    readdirMock.mockImplementation(async (target: string) => {
      switch (target) {
        case sessionsRoot:
          return [dirEntry("2026")];
        case join(sessionsRoot, "2026"):
          return [dirEntry("04")];
        case join(sessionsRoot, "2026", "04"):
          return [dirEntry("08")];
        case aprilDir:
          return [
            fileEntry(`rollout-2026-04-08T22-35-37-${olderSessionId}.jsonl`),
            fileEntry(`rollout-2026-04-08T22-38-48-${newerSessionId}.jsonl`),
          ];
        default:
          return [];
      }
    });

    statMock.mockImplementation(async (target: string) => {
      if (target === olderFile) {
        return {
          birthtime: new Date("2026-04-08T17:35:37.149Z"),
          mtime: new Date("2026-04-08T17:36:37.149Z"),
        };
      }

      if (target === newerFile) {
        return {
          birthtime: new Date("2026-04-08T17:38:48.271Z"),
          mtime: new Date("2026-04-08T17:39:48.271Z"),
        };
      }

      throw new Error(`Unexpected stat path: ${target}`);
    });

    readFileMock.mockImplementation(async (target: string) => {
      if (target === olderFile) {
        return [
          JSON.stringify({
            timestamp: "2026-04-08T17:35:44.135Z",
            type: "session_meta",
            payload: {
              id: olderSessionId,
              timestamp: "2026-04-08T17:35:37.149Z",
              cwd: "C:/projects/other",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:35:50.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Older prompt",
            },
          }),
        ].join("\n");
      }

      if (target === newerFile) {
        return [
          JSON.stringify({
            timestamp: "2026-04-08T17:38:54.517Z",
            type: "session_meta",
            payload: {
              id: newerSessionId,
              timestamp: "2026-04-08T17:38:48.271Z",
              cwd: "C:/projects/current",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:39:00.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Continue this conversation",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:39:09.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 35580,
                  cached_input_tokens: 5504,
                  output_tokens: 1029,
                  reasoning_output_tokens: 720,
                  total_tokens: 36609,
                },
              },
              rate_limits: {
                limit_id: "codex",
                limit_name: null,
                primary: {
                  used_percent: 92,
                  window_minutes: 300,
                  resets_at: 4080085200,
                },
                secondary: {
                  used_percent: 45,
                  window_minutes: 10080,
                  resets_at: 4080690000,
                },
                credits: null,
                plan_type: "pro",
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:39:05.000Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              message: "Working on it",
              phase: "commentary",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:39:10.000Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              message: "Final answer",
              phase: "final_answer",
            },
          }),
        ].join("\n");
      }

      if (target === authFile) {
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            id_token: [
              "header",
              Buffer.from(
                JSON.stringify({
                  name: "Anton Ageev",
                  email: "ichi.chaik@gmail.com",
                  "https://api.openai.com/auth": {
                    chatgpt_plan_type: "pro",
                  },
                }),
              ).toString("base64url"),
              "signature",
            ].join("."),
            account_id: "account-codex-1",
          },
        });
      }

      throw new Error(`Unexpected readFile path: ${target}`);
    });

    sessionsModule = await import("../adapters/codex/sessions.js");
  });

  it("lists nested rollout files as sessions ordered by file mtime", async () => {
    const sessions = await sessionsModule.listCodexSdkSessions({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      limit: 10,
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: newerSessionId,
      profileId: "profile-1",
      title: "Continue this conversation",
      createdAt: "2026-04-08T17:38:48.271Z",
      updatedAt: "2026-04-08T17:39:48.271Z",
    });
    expect(sessions[1]).toMatchObject({
      id: olderSessionId,
      title: "Older prompt",
      createdAt: "2026-04-08T17:35:37.149Z",
      updatedAt: "2026-04-08T17:36:37.149Z",
    });
  });

  it("filters nested rollout files by projectRoot", async () => {
    const sessions = await sessionsModule.listCodexSdkSessions({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "C:/projects/current",
      limit: 10,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: newerSessionId,
      profileId: "profile-1",
      title: "Continue this conversation",
    });
  });

  it("loads a specific session and parses visible user/assistant events", async () => {
    const session = await sessionsModule.getCodexSdkSession({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      sessionId: newerSessionId,
    });
    const events = await sessionsModule.listCodexSdkSessionEvents({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      sessionId: newerSessionId,
    });

    expect(session).toMatchObject({
      id: newerSessionId,
      title: "Continue this conversation",
    });
    expect(events).toEqual([
      expect.objectContaining({
        message: "Continue this conversation",
        data: expect.objectContaining({ role: "user" }),
      }),
      expect.objectContaining({
        message: "Final answer",
        data: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
  });

  it("parses the latest Codex token_count rate limits into a runtime limit snapshot", async () => {
    const snapshot = await sessionsModule.getCodexSessionLimitSnapshot({
      sessionId: newerSessionId,
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });

    expect(snapshot).toEqual({
      source: "sdk_event",
      status: "warning",
      precision: "exact",
      checkedAt: "2026-04-08T17:39:09.000Z",
      providerId: "openai",
      runtimeId: "codex",
      profileId: "profile-1",
      primaryScope: "time",
      resetAt: "2099-04-17T05:00:00.000Z",
      retryAfterSeconds: null,
      warningThreshold: 10,
      windows: [
        {
          scope: "time",
          name: "5h",
          unit: "minutes",
          percentUsed: 92,
          percentRemaining: 8,
          resetAt: "2099-04-17T05:00:00.000Z",
          warningThreshold: 10,
        },
        {
          scope: "time",
          name: "7d",
          unit: "minutes",
          percentUsed: 45,
          percentRemaining: 55,
          resetAt: "2099-04-24T05:00:00.000Z",
          warningThreshold: 10,
        },
      ],
      providerMeta: {
        limitId: "codex",
        limitName: null,
        planType: "pro",
        accountId: "account-codex-1",
        authMode: "chatgpt",
        accountName: "Anton Ageev",
        accountEmail: "ichi.chaik@gmail.com",
        credits: {
          hasCredits: null,
          unlimited: null,
          balance: null,
        },
      },
    });
  });
});
