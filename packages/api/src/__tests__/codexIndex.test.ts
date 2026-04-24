import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockAppendCodexLimitHistory = vi.fn(() => 0);
const mockBuildCodexLimitHeadKey = vi.fn(() => "head-key");
const mockDeleteCodexLimitHeadsByFilePaths = vi.fn(() => 0);
const mockDeleteCodexLimitHistoryByFilePaths = vi.fn(() => 0);
const mockDeleteCodexSessionsByFilePaths = vi.fn(() => 0);
const mockListCodexLimitHeadScopesByFilePaths = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListCodexSessionFileStates = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListProjects = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListRuntimeProfileResponses = vi.fn(
  (..._args: any[]) => [] as Array<Record<string, unknown>>,
);
const mockPruneCodexLimitHistoryRetention = vi.fn(() => 0);
const mockUpsertCodexIndexCursor = vi.fn(() => undefined);
const mockUpsertCodexLimitHeads = vi.fn(() => 0);
const mockUpsertCodexSessionFiles = vi.fn(() => 0);
const mockUpsertCodexSessions = vi.fn(() => 0);
const mockNotifyRuntimeLimitProjectUpdate = vi.fn();

const mockBuildCodexAuthFingerprint = vi.fn(() => "fp-1");
const mockClassifyCodexSessionFileStatus = vi.fn(() => "new");
const mockGetCodexAuthIdentity = vi.fn(async (): Promise<any> => null);
const mockListCodexSessionFileInfos = vi.fn(async (): Promise<any[]> => []);
const mockReadCodexSessionLimitSnapshotsFromAppend = vi.fn(
  async (): Promise<any> => ({ snapshots: [], parsedOffset: 0, pendingTail: "" }),
);
const mockReadCodexSessionLimitSnapshotsFromFile = vi.fn(async (): Promise<any[]> => []);
const mockReadCodexSessionMetaFromFile = vi.fn(async (): Promise<any> => null);
const mockReadCodexSnapshotAccountFingerprint = vi.fn(() => null);
const mockReadLatestCodexSessionLimitSnapshotFromFile = vi.fn(async (): Promise<any> => null);

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    logger: vi.fn(() => mockLog),
  };
});

vi.mock("@aif/data", () => ({
  appendCodexLimitHistory: mockAppendCodexLimitHistory,
  buildCodexLimitHeadKey: mockBuildCodexLimitHeadKey,
  deleteCodexLimitHeadsByFilePaths: mockDeleteCodexLimitHeadsByFilePaths,
  deleteCodexLimitHistoryByFilePaths: mockDeleteCodexLimitHistoryByFilePaths,
  deleteCodexSessionsByFilePaths: mockDeleteCodexSessionsByFilePaths,
  listCodexLimitHeadScopesByFilePaths: mockListCodexLimitHeadScopesByFilePaths,
  listCodexSessionFileStates: mockListCodexSessionFileStates,
  listProjects: mockListProjects,
  listRuntimeProfileResponses: mockListRuntimeProfileResponses,
  pruneCodexLimitHistoryRetention: mockPruneCodexLimitHistoryRetention,
  upsertCodexIndexCursor: mockUpsertCodexIndexCursor,
  upsertCodexLimitHeads: mockUpsertCodexLimitHeads,
  upsertCodexSessionFiles: mockUpsertCodexSessionFiles,
  upsertCodexSessions: mockUpsertCodexSessions,
}));

vi.mock("@aif/runtime", () => ({
  buildCodexAuthFingerprint: mockBuildCodexAuthFingerprint,
  classifyCodexSessionFileStatus: mockClassifyCodexSessionFileStatus,
  getCodexAuthIdentity: mockGetCodexAuthIdentity,
  listCodexSessionFileInfos: mockListCodexSessionFileInfos,
  normalizeCodexProjectPath: (value: string | null | undefined) => {
    if (!value) return null;
    const normalized = value
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    return normalized.length > 0 ? normalized : null;
  },
  readCodexSessionLimitSnapshotsFromAppend: mockReadCodexSessionLimitSnapshotsFromAppend,
  readCodexSessionLimitSnapshotsFromFile: mockReadCodexSessionLimitSnapshotsFromFile,
  readCodexSessionMetaFromFile: mockReadCodexSessionMetaFromFile,
  readCodexSnapshotAccountFingerprint: mockReadCodexSnapshotAccountFingerprint,
  readLatestCodexSessionLimitSnapshotFromFile: mockReadLatestCodexSessionLimitSnapshotFromFile,
}));

vi.mock("../services/runtime.js", () => ({
  notifyRuntimeLimitProjectUpdate: mockNotifyRuntimeLimitProjectUpdate,
}));

async function loadService() {
  return import("../services/codexIndex.js");
}

describe("codex index service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockListCodexSessionFileStates.mockReturnValue([]);
    mockListCodexSessionFileInfos.mockResolvedValue([]);
    mockClassifyCodexSessionFileStatus.mockReturnValue("new");
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [],
      parsedOffset: 0,
      pendingTail: "",
    });
    mockListCodexLimitHeadScopesByFilePaths.mockReturnValue([]);
    mockListProjects.mockReturnValue([]);
    mockListRuntimeProfileResponses.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts once, performs warm-up reconcile, and schedules loop ticks", async () => {
    const { createCodexIndexService } = await loadService();
    const service = createCodexIndexService({ reconcileIntervalMs: 1000 });

    await service.start();
    await service.start();

    expect(service.isRunning()).toBe(true);
    expect(mockListCodexSessionFileInfos).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    await vi.runOnlyPendingTimersAsync();
    expect(mockListCodexSessionFileInfos.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns the same in-flight reconcile promise when called concurrently", async () => {
    const { createCodexIndexService } = await loadService();
    const resolveListRef: { current: null | (() => void) } = { current: null };
    mockListCodexSessionFileInfos.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListRef.current = () => resolve([]);
        }),
    );

    const service = createCodexIndexService();
    const first = service.runReconcileOnce("manual-1");
    const second = service.runReconcileOnce("manual-2");
    await Promise.resolve();
    expect(resolveListRef.current).toBeTypeOf("function");

    const resolveList = resolveListRef.current;
    if (!resolveList) {
      throw new Error("Expected reconcile promise resolver");
    }
    resolveList();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(mockListCodexSessionFileInfos).toHaveBeenCalledTimes(1);
  });

  it("marks missing files and deletes indexed session rows for vanished paths", async () => {
    const { createCodexIndexService } = await loadService();
    mockListCodexSessionFileStates.mockReturnValue([
      {
        filePath: "/tmp/codex/missing.jsonl",
        sessionId: "session-1",
        sizeBytes: 100,
        mtimeMs: 100,
        parsedOffset: 100,
        pendingTail: "",
        missing: false,
        importVersion: 1,
        lastSeenAt: "2026-04-23T00:00:00.000Z",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    mockListCodexSessionFileInfos.mockResolvedValue([]);

    const service = createCodexIndexService();
    const summary = await service.runReconcileOnce("manual");

    expect(summary.missingFiles).toBe(1);
    expect(mockDeleteCodexSessionsByFilePaths).toHaveBeenCalledWith(["/tmp/codex/missing.jsonl"]);
    expect(mockDeleteCodexLimitHeadsByFilePaths).toHaveBeenCalledWith(["/tmp/codex/missing.jsonl"]);
    expect(mockDeleteCodexLimitHistoryByFilePaths).toHaveBeenCalledWith([
      "/tmp/codex/missing.jsonl",
    ]);
    expect(mockUpsertCodexSessionFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "/tmp/codex/missing.jsonl",
          missing: true,
        }),
      ]),
    );
  });

  it("notifies visible project runtime profiles when stale limit heads are deleted without replacements", async () => {
    const { createCodexIndexService } = await loadService();
    mockListCodexSessionFileStates.mockReturnValue([
      {
        filePath: "/tmp/project-1/.codex/sessions/deleted.jsonl",
        sessionId: "session-deleted",
        sizeBytes: 100,
        mtimeMs: 100,
        parsedOffset: 100,
        pendingTail: "",
        missing: false,
        importVersion: 1,
        lastSeenAt: "2026-04-23T00:00:00.000Z",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    mockListCodexSessionFileInfos.mockResolvedValue([]);
    mockListCodexLimitHeadScopesByFilePaths.mockReturnValue([
      {
        headKey: "head-key",
        projectRoot: "/tmp/project-1",
        observedAt: "2026-04-23T00:00:02.000Z",
        filePath: "/tmp/project-1/.codex/sessions/deleted.jsonl",
      },
    ]);
    mockDeleteCodexLimitHeadsByFilePaths.mockReturnValue(1);
    mockDeleteCodexLimitHistoryByFilePaths.mockReturnValue(1);
    mockListProjects.mockReturnValue([
      { id: "project-1", rootPath: "/tmp/project-1" },
      { id: "project-2", rootPath: "/tmp/project-2" },
    ]);
    mockListRuntimeProfileResponses.mockImplementation((input: { projectId: string }) =>
      input.projectId === "project-1"
        ? [
            {
              id: "profile-codex-1",
              runtimeId: "codex",
              transport: "sdk",
              enabled: true,
            },
          ]
        : [],
    );

    const service = createCodexIndexService();
    const summary = await service.runReconcileOnce("manual");

    expect(summary.headRowsDeleted).toBe(1);
    expect(mockListCodexLimitHeadScopesByFilePaths).toHaveBeenCalledWith([
      "/tmp/project-1/.codex/sessions/deleted.jsonl",
    ]);
    expect(mockNotifyRuntimeLimitProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runtimeProfileId: "profile-codex-1",
      }),
    );
  });

  it("parses only the appended Codex session range using the stored cursor state", async () => {
    const { createCodexIndexService } = await loadService();
    const fileInfo = {
      filePath: "/tmp/codex/appended.jsonl",
      birthtimeMs: 100,
      mtimeMs: 250,
      size: 300,
    };
    mockListCodexSessionFileStates.mockReturnValue([
      {
        filePath: fileInfo.filePath,
        sessionId: "session-appended",
        sizeBytes: 120,
        mtimeMs: 200,
        parsedOffset: 96,
        pendingTail: '{"timestamp":"partial',
        missing: false,
        importVersion: 1,
        lastSeenAt: "2026-04-23T00:00:00.000Z",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    mockListCodexSessionFileInfos.mockResolvedValue([fileInfo]);
    mockClassifyCodexSessionFileStatus.mockReturnValue("appended");
    mockReadCodexSessionMetaFromFile.mockResolvedValue({
      id: "session-appended",
      model: "gpt-5.4",
      prompt: "Prompt",
      cwd: "/tmp/project",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:01.000Z",
      filePath: fileInfo.filePath,
    });
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [
        {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-23T00:00:02.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: null,
          primaryScope: "time",
          resetAt: "2026-04-23T02:00:00.000Z",
          retryAfterSeconds: null,
          warningThreshold: 10,
          windows: [],
          providerMeta: { limitId: "codex" },
        },
      ],
      parsedOffset: 300,
      pendingTail: "",
    });

    const service = createCodexIndexService();
    await service.runReconcileOnce("manual");

    expect(mockReadCodexSessionLimitSnapshotsFromAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        fileInfo,
        startOffset: 96,
        pendingTail: '{"timestamp":"partial',
        runtimeId: "codex",
        providerId: "openai",
      }),
    );
    expect(mockReadLatestCodexSessionLimitSnapshotFromFile).not.toHaveBeenCalled();
    expect(mockReadCodexSessionLimitSnapshotsFromFile).not.toHaveBeenCalled();
    expect(mockUpsertCodexSessionFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: fileInfo.filePath,
          parsedOffset: 300,
          pendingTail: "",
        }),
      ]),
    );
  });

  it("fully reparses rewritten Codex session files while preserving cursor tails", async () => {
    const { createCodexIndexService } = await loadService();
    const fileInfo = {
      filePath: "/tmp/codex/rewritten.jsonl",
      birthtimeMs: 100,
      mtimeMs: 250,
      size: 80,
    };
    mockListCodexSessionFileStates.mockReturnValue([
      {
        filePath: fileInfo.filePath,
        sessionId: "session-rewritten",
        sizeBytes: 120,
        mtimeMs: 200,
        parsedOffset: 96,
        pendingTail: '{"timestamp":"partial',
        missing: false,
        importVersion: 1,
        lastSeenAt: "2026-04-23T00:00:00.000Z",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
    ]);
    mockListCodexSessionFileInfos.mockResolvedValue([fileInfo]);
    mockClassifyCodexSessionFileStatus.mockReturnValue("rewrite");
    mockReadCodexSessionMetaFromFile.mockResolvedValue({
      id: "session-rewritten",
      model: "gpt-5.4",
      prompt: "Prompt",
      cwd: "/tmp/project",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:01.000Z",
      filePath: fileInfo.filePath,
    });
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [],
      parsedOffset: 80,
      pendingTail: '{"timestamp":',
    });

    const service = createCodexIndexService();
    await service.runReconcileOnce("manual");

    expect(mockReadCodexSessionLimitSnapshotsFromAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        fileInfo,
        startOffset: 0,
        pendingTail: "",
        runtimeId: "codex",
        providerId: "openai",
      }),
    );
    expect(mockReadCodexSessionLimitSnapshotsFromFile).not.toHaveBeenCalled();
    expect(mockReadLatestCodexSessionLimitSnapshotFromFile).not.toHaveBeenCalled();
    expect(mockDeleteCodexLimitHeadsByFilePaths).toHaveBeenCalledWith([fileInfo.filePath]);
    expect(mockDeleteCodexLimitHistoryByFilePaths).toHaveBeenCalledWith([fileInfo.filePath]);
    expect(mockUpsertCodexSessionFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: fileInfo.filePath,
          parsedOffset: 80,
          pendingTail: '{"timestamp":',
        }),
      ]),
    );
  });

  it("stops the reconcile loop and is idempotent", async () => {
    const { createCodexIndexService } = await loadService();
    const service = createCodexIndexService({ reconcileIntervalMs: 1000 });

    await service.start();
    await service.stop();
    await service.stop();

    const callsAfterStop = mockListCodexSessionFileInfos.mock.calls.length;
    vi.advanceTimersByTime(3000);
    await vi.runOnlyPendingTimersAsync();

    expect(service.isRunning()).toBe(false);
    expect(mockListCodexSessionFileInfos).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("notifies visible project runtime profiles when limit heads are updated", async () => {
    const { createCodexIndexService } = await loadService();
    mockListCodexSessionFileInfos.mockResolvedValue([
      {
        filePath: "/tmp/project-1/.codex/sessions/a.jsonl",
        birthtimeMs: 100,
        mtimeMs: 200,
        size: 300,
      },
    ]);
    mockReadCodexSessionMetaFromFile.mockResolvedValue({
      id: "codex-session-1",
      model: "gpt-5.4",
      prompt: "Prompt",
      cwd: "/tmp/project-1",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:01.000Z",
      filePath: "/tmp/project-1/.codex/sessions/a.jsonl",
    });
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [
        {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-23T00:00:02.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: null,
          primaryScope: "time",
          resetAt: "2026-04-23T02:00:00.000Z",
          retryAfterSeconds: null,
          warningThreshold: 10,
          windows: [],
          providerMeta: { limitId: "codex" },
        },
      ],
      parsedOffset: 300,
      pendingTail: "",
    });
    mockListProjects.mockReturnValue([
      { id: "project-1", rootPath: "/tmp/project-1" },
      { id: "project-2", rootPath: "/tmp/project-2" },
    ]);
    mockListRuntimeProfileResponses.mockImplementation((input: { projectId: string }) =>
      input.projectId === "project-1"
        ? [
            {
              id: "profile-codex-1",
              runtimeId: "codex",
              transport: "sdk",
              enabled: true,
            },
          ]
        : [],
    );
    mockUpsertCodexLimitHeads.mockReturnValue(1);

    const service = createCodexIndexService();
    await service.runReconcileOnce("manual");

    expect(mockNotifyRuntimeLimitProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runtimeProfileId: "profile-codex-1",
      }),
    );
  });

  it("normalizes Codex project roots before notifying visible project profiles", async () => {
    const { createCodexIndexService } = await loadService();
    mockListCodexSessionFileInfos.mockResolvedValue([
      {
        filePath: "C:/Projects/One/.codex/sessions/a.jsonl",
        birthtimeMs: 100,
        mtimeMs: 200,
        size: 300,
      },
    ]);
    mockReadCodexSessionMetaFromFile.mockResolvedValue({
      id: "codex-session-1",
      model: "gpt-5.4",
      prompt: "Prompt",
      cwd: "C:\\Projects\\One\\",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:01.000Z",
      filePath: "C:/Projects/One/.codex/sessions/a.jsonl",
    });
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [
        {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-23T00:00:02.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: null,
          primaryScope: "time",
          resetAt: "2026-04-23T02:00:00.000Z",
          retryAfterSeconds: null,
          warningThreshold: 10,
          windows: [],
          providerMeta: { limitId: "codex" },
        },
      ],
      parsedOffset: 300,
      pendingTail: "",
    });
    mockListProjects.mockReturnValue([{ id: "project-1", rootPath: "c:/projects/one" }]);
    mockListRuntimeProfileResponses.mockReturnValue([
      {
        id: "profile-codex-1",
        runtimeId: "codex",
        transport: "sdk",
        enabled: true,
      },
    ]);
    mockUpsertCodexLimitHeads.mockReturnValue(1);

    const service = createCodexIndexService();
    await service.runReconcileOnce("manual");

    expect(mockNotifyRuntimeLimitProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        runtimeProfileId: "profile-codex-1",
      }),
    );
  });
});
