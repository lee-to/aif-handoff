import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { join } from "node:path";

const readdirMock = vi.fn();
const readFileMock = vi.fn();
const statMock = vi.fn();
const createReadStreamMock = vi.fn();

vi.mock("node:os", () => ({
  homedir: () => "C:/Users/test",
}));

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    createReadStream: (path: string, options?: { start?: number; end?: number }) => {
      createReadStreamMock(path, options);
      // Reuse readFile mock so each test only configures one source of
      // session-file content; stream reads just yield the full payload.
      const stream = Readable.from(
        (async function* () {
          const data = await readFileMock(path, "utf-8");
          const text = typeof data === "string" ? data : String(data ?? "");
          const start = typeof options?.start === "number" ? options.start : 0;
          const end = typeof options?.end === "number" ? options.end + 1 : undefined;
          yield text.slice(start, end);
        })(),
      );
      return stream as unknown as ReturnType<typeof import("node:fs").createReadStream>;
    },
  };
});

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
  const alternatePoolSessionId = "019d6e2d-a143-7642-8917-06f51e30ee85";
  const olderFile = join(aprilDir, `rollout-2026-04-08T22-35-37-${olderSessionId}.jsonl`);
  const newerFile = join(aprilDir, `rollout-2026-04-08T22-38-48-${newerSessionId}.jsonl`);
  const alternatePoolFile = join(
    aprilDir,
    `rollout-2026-04-08T22-39-48-${alternatePoolSessionId}.jsonl`,
  );

  let sessionsModule: SessionsModule;

  beforeEach(async () => {
    vi.resetModules();
    readdirMock.mockReset();
    readFileMock.mockReset();
    statMock.mockReset();
    createReadStreamMock.mockReset();

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
            fileEntry(`rollout-2026-04-08T22-39-48-${alternatePoolSessionId}.jsonl`),
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

      if (target === alternatePoolFile) {
        return {
          birthtime: new Date("2026-04-08T17:39:48.271Z"),
          mtime: new Date("2026-04-08T17:40:48.271Z"),
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
              model: "gpt-5.3-codex",
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
            timestamp: "2026-04-08T17:38:56.000Z",
            type: "turn_context",
            payload: {
              model: "gpt-5.4",
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

      if (target === alternatePoolFile) {
        return [
          JSON.stringify({
            timestamp: "2026-04-08T17:39:54.517Z",
            type: "session_meta",
            payload: {
              id: alternatePoolSessionId,
              timestamp: "2026-04-08T17:39:48.271Z",
              cwd: "C:/projects/current",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:39:55.000Z",
            type: "turn_context",
            payload: {
              model: "gpt-5.4",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-08T17:40:09.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 5120,
                  cached_input_tokens: 1024,
                  output_tokens: 256,
                  reasoning_output_tokens: 64,
                  total_tokens: 5376,
                },
              },
              rate_limits: {
                limit_id: "codex_bengalfox",
                limit_name: null,
                primary: {
                  used_percent: 0,
                  window_minutes: 300,
                  resets_at: 4080123600,
                },
                secondary: {
                  used_percent: 30,
                  window_minutes: 10080,
                  resets_at: 4080733200,
                },
                credits: null,
                plan_type: "pro",
              },
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

    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({
      id: alternatePoolSessionId,
      model: "gpt-5.4",
      profileId: "profile-1",
      createdAt: "2026-04-08T17:39:48.271Z",
      updatedAt: "2026-04-08T17:40:48.271Z",
    });
    expect(sessions[1]).toMatchObject({
      id: newerSessionId,
      model: "gpt-5.4",
      profileId: "profile-1",
      title: "Continue this conversation",
      createdAt: "2026-04-08T17:38:48.271Z",
      updatedAt: "2026-04-08T17:39:48.271Z",
    });
    expect(sessions[2]).toMatchObject({
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

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: alternatePoolSessionId,
      profileId: "profile-1",
    });
    expect(sessions[1]).toMatchObject({
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

  it("reads session events directly from a known file path without session-id discovery", async () => {
    const events = await sessionsModule.readCodexSessionEventsFromFile(newerFile, { limit: 1 });

    expect(events).toEqual([
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
        accountFingerprint: expect.any(String),
        credits: {
          hasCredits: null,
          unlimited: null,
          balance: null,
        },
      },
    });
  });

  it("finds the latest limit snapshot for a specific model within the project root", async () => {
    const snapshot = await sessionsModule.getLatestCodexModelLimitSnapshot({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "C:/projects/current",
      model: "gpt-5.4",
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        checkedAt: "2026-04-08T17:40:09.000Z",
        profileId: "profile-1",
        providerMeta: expect.objectContaining({
          limitId: "codex_bengalfox",
          accountId: "account-codex-1",
        }),
      }),
    );
  });

  it("lists the latest Codex limit snapshots per limit pool for a project root", async () => {
    const snapshots = await sessionsModule.listLatestCodexLimitSnapshots({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "C:/projects/current",
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.providerMeta?.limitId)).toEqual([
      "codex_bengalfox",
      "codex",
    ]);
  });

  it("prefers the alternate Codex pool for Spark models and the default pool otherwise", async () => {
    const snapshots = await sessionsModule.listLatestCodexLimitSnapshots({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "C:/projects/current",
    });

    const sparkSnapshot = sessionsModule.selectPreferredCodexLimitSnapshot({
      model: "gpt-5.3-codex-spark",
      snapshots,
    });
    const mainSnapshot = sessionsModule.selectPreferredCodexLimitSnapshot({
      model: "gpt-5.4",
      snapshots,
    });

    expect(sparkSnapshot?.providerMeta?.limitId).toBe("codex_bengalfox");
    expect(mainSnapshot?.providerMeta?.limitId).toBe("codex");
  });

  it("pushes the session scan cap before hydrating every rollout meta", async () => {
    const bulkFiles = Array.from({ length: 120 }, (_, index) => {
      const id = `019d6e2c-e143-7642-8917-${index.toString(16).padStart(12, "0")}`;
      return {
        id,
        file: `rollout-2026-04-08T22-38-48-${id}.jsonl`,
        fullPath: join(aprilDir, `rollout-2026-04-08T22-38-48-${id}.jsonl`),
        mtime: new Date(`2026-04-08T17:${(index % 60).toString().padStart(2, "0")}:48.271Z`),
      };
    });

    readdirMock.mockImplementation(async (target: string) => {
      switch (target) {
        case sessionsRoot:
          return [dirEntry("2026")];
        case join(sessionsRoot, "2026"):
          return [dirEntry("04")];
        case join(sessionsRoot, "2026", "04"):
          return [dirEntry("08")];
        case aprilDir:
          return bulkFiles.map((f) => fileEntry(f.file));
        default:
          return [];
      }
    });

    statMock.mockImplementation(async (target: string) => {
      const match = bulkFiles.find((f) => f.fullPath === target);
      if (!match) throw new Error(`Unexpected stat path: ${target}`);
      return { birthtime: match.mtime, mtime: match.mtime };
    });

    const limitPayload = (id: string) =>
      JSON.stringify({
        timestamp: "2026-04-08T17:39:09.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: id,
            primary: { used_percent: 10, window_minutes: 300, resets_at: 4080085200 },
          },
        },
      });

    const metaLine = (id: string) =>
      JSON.stringify({
        timestamp: "2026-04-08T17:38:54.517Z",
        type: "session_meta",
        payload: { id, cwd: "C:/projects/current" },
      });

    const readCalls: string[] = [];
    readFileMock.mockImplementation(async (target: string) => {
      readCalls.push(target);
      if (target === authFile) {
        return JSON.stringify({
          tokens: {
            id_token: null,
            access_token: null,
            refresh_token: null,
            account_id: null,
          },
        });
      }
      const match = bulkFiles.find((f) => f.fullPath === target);
      if (!match) return "";
      return [metaLine(match.id), limitPayload(match.id)].join("\n");
    });

    await sessionsModule.listLatestCodexLimitSnapshots({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      projectRoot: "C:/projects/current",
    });

    const sessionReads = readCalls.filter((path) => path !== authFile);
    // 50 matching meta reads + 50 limit-snapshot reads. The old path read all
    // 120 metas before applying the snapshot scan cap.
    expect(sessionReads.length).toBeLessThanOrEqual(100);
    expect(sessionReads.length).toBeLessThan(120);
  });

  it("reads recent limit snapshots from the file tail for global latest scans", async () => {
    const filler = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({
        timestamp: "2026-04-08T17:38:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `filler ${index}`,
        },
      }),
    ).join("\n");
    const tokenCountLine = JSON.stringify({
      timestamp: "2026-04-08T17:39:09.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 10, window_minutes: 300, resets_at: 4080085200 },
        },
      },
    });
    const sessionContent = `${filler}\n${tokenCountLine}`;

    readdirMock.mockImplementation(async (target: string) => {
      switch (target) {
        case sessionsRoot:
          return [dirEntry("2026")];
        case join(sessionsRoot, "2026"):
          return [dirEntry("04")];
        case join(sessionsRoot, "2026", "04"):
          return [dirEntry("08")];
        case aprilDir:
          return [fileEntry(`rollout-2026-04-08T22-38-48-${newerSessionId}.jsonl`)];
        default:
          return [];
      }
    });

    statMock.mockImplementation(async (target: string) => {
      if (target !== newerFile) throw new Error(`Unexpected stat path: ${target}`);
      return {
        birthtime: new Date("2026-04-08T17:38:48.271Z"),
        mtime: new Date("2026-04-08T17:39:48.271Z"),
        size: Buffer.byteLength(sessionContent),
      };
    });

    readFileMock.mockImplementation(async (target: string) => {
      if (target === authFile) {
        return JSON.stringify({
          tokens: {
            id_token: null,
            access_token: null,
            refresh_token: null,
            account_id: null,
          },
        });
      }
      if (target === newerFile) {
        return sessionContent;
      }
      throw new Error(`Unexpected readFile path: ${target}`);
    });

    const snapshots = await sessionsModule.listLatestCodexLimitSnapshots({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.providerMeta?.limitId).toBe("codex");
    const sessionStreamCalls = createReadStreamMock.mock.calls.filter(
      ([path]) => path === newerFile,
    );
    expect(sessionStreamCalls).toHaveLength(1);
    expect(sessionStreamCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        start: Buffer.byteLength(sessionContent) - 64 * 1024,
        end: Buffer.byteLength(sessionContent) - 1,
      }),
    );
  });

  it("does not crash when a token_count event omits rate_limits", async () => {
    readFileMock.mockImplementation(async (target: string) => {
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
            timestamp: "2026-04-08T17:39:09.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { total_tokens: 100 } },
              rate_limits: null,
            },
          }),
        ].join("\n");
      }
      if (target === authFile) {
        return JSON.stringify({
          tokens: {
            id_token: null,
            access_token: null,
            refresh_token: null,
            account_id: null,
          },
        });
      }
      return "";
    });

    const snapshot = await sessionsModule.getCodexSessionLimitSnapshot({
      sessionId: newerSessionId,
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });

    expect(snapshot).toBeNull();
  });

  it("builds deterministic auth fingerprints and reads them from snapshots", async () => {
    const identity = await sessionsModule.getCodexAuthIdentity();
    const fingerprint = sessionsModule.buildCodexAuthFingerprint(identity);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const snapshot = await sessionsModule.getCodexSessionLimitSnapshot({
      sessionId: newerSessionId,
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });
    const snapshotFingerprint = sessionsModule.readCodexSnapshotAccountFingerprint(snapshot);
    expect(snapshotFingerprint).toBe(fingerprint);
  });

  it("classifies codex file dirtiness for indexer reconciliation", () => {
    const baseInfo = {
      filePath: newerFile,
      birthtimeMs: Date.parse("2026-04-08T17:38:48.271Z"),
      mtimeMs: Date.parse("2026-04-08T17:39:48.271Z"),
      size: 1024,
    };

    expect(
      sessionsModule.classifyCodexSessionFileStatus({
        previous: null,
        current: baseInfo,
        importVersion: 1,
      }),
    ).toBe("new");
    expect(
      sessionsModule.classifyCodexSessionFileStatus({
        previous: { sizeBytes: 1024, mtimeMs: baseInfo.mtimeMs, importVersion: 1 },
        current: baseInfo,
        importVersion: 1,
      }),
    ).toBe("unchanged");
    expect(
      sessionsModule.classifyCodexSessionFileStatus({
        previous: { sizeBytes: 1024, mtimeMs: baseInfo.mtimeMs, importVersion: 1 },
        current: { ...baseInfo, size: 2048, mtimeMs: baseInfo.mtimeMs + 10 },
        importVersion: 1,
      }),
    ).toBe("appended");
    expect(
      sessionsModule.classifyCodexSessionFileStatus({
        previous: { sizeBytes: 1024, mtimeMs: baseInfo.mtimeMs, importVersion: 1 },
        current: { ...baseInfo, size: 512, mtimeMs: baseInfo.mtimeMs + 10 },
        importVersion: 1,
      }),
    ).toBe("rewrite");
    expect(
      sessionsModule.classifyCodexSessionFileStatus({
        previous: { sizeBytes: 1024, mtimeMs: baseInfo.mtimeMs, importVersion: 1 },
        current: null,
        importVersion: 1,
      }),
    ).toBe("missing");
  });

  it("exposes file inventory and fast latest-snapshot parsing helpers for ingestion", async () => {
    const files = await sessionsModule.listCodexSessionFileInfos();
    expect(files[0]?.filePath).toBe(alternatePoolFile);

    const newestTwoFiles = await sessionsModule.listCodexSessionFileInfos({ limitNewest: 2 });
    expect(newestTwoFiles.map((file) => file.filePath)).toEqual([alternatePoolFile, newerFile]);

    const meta = await sessionsModule.readCodexSessionMetaFromFile(files[0]!);
    expect(meta?.id).toBe(alternatePoolSessionId);

    const latest = await sessionsModule.readLatestCodexSessionLimitSnapshotFromFile({
      fileInfo: files[0]!,
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });
    expect(latest?.providerMeta?.limitId).toBe("codex_bengalfox");
  });

  it("filters Codex session file inventory by modified time and skips old dated directories", async () => {
    const oldDir = join(sessionsRoot, "2026", "04", "01");
    const recentDir = join(sessionsRoot, "2026", "04", "10");
    const oldFile = join(oldDir, `rollout-2026-04-01T10-00-00-${olderSessionId}.jsonl`);
    const recentFile = join(recentDir, `rollout-2026-04-10T10-00-00-${newerSessionId}.jsonl`);
    readdirMock.mockImplementation(async (target: string) => {
      switch (target) {
        case sessionsRoot:
          return [dirEntry("2026")];
        case join(sessionsRoot, "2026"):
          return [dirEntry("04")];
        case join(sessionsRoot, "2026", "04"):
          return [dirEntry("01"), dirEntry("10")];
        case oldDir:
          return [fileEntry(`rollout-2026-04-01T10-00-00-${olderSessionId}.jsonl`)];
        case recentDir:
          return [fileEntry(`rollout-2026-04-10T10-00-00-${newerSessionId}.jsonl`)];
        default:
          return [];
      }
    });
    statMock.mockImplementation(async (target: string) => {
      if (target === oldFile) {
        throw new Error("Old dated session directory should not be statted");
      }
      if (target === recentFile) {
        return {
          birthtime: new Date("2026-04-10T10:00:00.000Z"),
          mtime: new Date("2026-04-10T10:01:00.000Z"),
          size: 10,
        };
      }
      throw new Error(`Unexpected stat path: ${target}`);
    });

    const files = await sessionsModule.listCodexSessionFileInfos({
      modifiedAfterMs: Date.parse("2026-04-03T00:00:00.000Z"),
    });

    expect(files.map((file) => file.filePath)).toEqual([recentFile]);
    expect(statMock).not.toHaveBeenCalledWith(oldFile);
  });

  it("parses appended limit snapshots from a stored offset and carries an incomplete tail", async () => {
    const appendFile = join(aprilDir, `rollout-2026-04-08T22-41-48-${newerSessionId}.jsonl`);
    const completeLine = JSON.stringify({
      timestamp: "2026-04-08T18:00:09.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 5,
            window_minutes: 300,
            resets_at: 4080085200,
          },
        },
      },
    });
    const pendingTail = completeLine.slice(0, 64);
    const appendedRange = `${completeLine.slice(64)}\n{"timestamp":`;
    const prefix = "already parsed\n";
    const content = `${prefix}${appendedRange}`;
    readFileMock.mockImplementation(async (target: string) => {
      if (target === appendFile) {
        return content;
      }
      if (target === authFile) {
        return JSON.stringify({
          tokens: {
            id_token: null,
            access_token: null,
            refresh_token: null,
            account_id: null,
          },
        });
      }
      return "";
    });

    const result = await sessionsModule.readCodexSessionLimitSnapshotsFromAppend({
      fileInfo: {
        filePath: appendFile,
        birthtimeMs: 100,
        mtimeMs: 200,
        size: Buffer.byteLength(content),
      },
      startOffset: Buffer.byteLength(prefix),
      pendingTail,
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });

    expect(result.parsedOffset).toBe(Buffer.byteLength(content));
    expect(result.pendingTail).toBe('{"timestamp":');
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.providerMeta?.limitId).toBe("codex");
    expect(createReadStreamMock).toHaveBeenCalledWith(
      appendFile,
      expect.objectContaining({
        start: Buffer.byteLength(prefix),
        end: Buffer.byteLength(content) - 1,
      }),
    );
  });
});
