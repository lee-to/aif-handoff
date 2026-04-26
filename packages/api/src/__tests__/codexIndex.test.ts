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
const mockDeleteCodexSessionFilesByFilePaths = vi.fn(() => 0);
const mockDeleteCodexSessionsByFilePaths = vi.fn(() => 0);
const mockListCodexLimitHeadScopesByFilePaths = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListCodexSessionFileStates = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListCodexSessionFileStatesByPaths = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListCodexLimitHeadsForOverlay = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListProjects = vi.fn(() => [] as Array<Record<string, unknown>>);
const mockListRuntimeProfileResponses = vi.fn(
  (..._args: any[]) => [] as Array<Record<string, unknown>>,
);
const mockPruneCodexLimitHistoryByHead = vi.fn(() => 0);
const mockPruneCodexLimitHistoryRetention = vi.fn(() => 0);
const mockPruneCodexLimitRowsBeforeObservedAt = vi.fn(() => ({
  deletedScopes: [] as Array<Record<string, unknown>>,
  headRowsDeleted: 0,
  historyRowsDeleted: 0,
}));
const mockPruneStaleCodexSessionIndexRows = vi.fn(() => ({
  sessionRowsDeleted: 0,
  fileRowsDeleted: 0,
  linkedRowsRetained: 0,
}));
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
const mockIsApiIdle = vi.fn(() => true);

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
  deleteCodexSessionFilesByFilePaths: mockDeleteCodexSessionFilesByFilePaths,
  deleteCodexSessionsByFilePaths: mockDeleteCodexSessionsByFilePaths,
  listCodexLimitHeadScopesByFilePaths: mockListCodexLimitHeadScopesByFilePaths,
  listCodexLimitHeadsForOverlay: mockListCodexLimitHeadsForOverlay,
  listCodexSessionFileStates: mockListCodexSessionFileStates,
  listCodexSessionFileStatesByPaths: mockListCodexSessionFileStatesByPaths,
  listProjects: mockListProjects,
  listRuntimeProfileResponses: mockListRuntimeProfileResponses,
  pruneCodexLimitHistoryByHead: mockPruneCodexLimitHistoryByHead,
  pruneCodexLimitHistoryRetention: mockPruneCodexLimitHistoryRetention,
  pruneCodexLimitRowsBeforeObservedAt: mockPruneCodexLimitRowsBeforeObservedAt,
  pruneStaleCodexSessionIndexRows: mockPruneStaleCodexSessionIndexRows,
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

vi.mock("../middleware/apiLoad.js", () => ({
  isApiIdle: mockIsApiIdle,
}));

async function loadService() {
  return import("../services/codexIndex.js");
}

describe("codex index service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIsApiIdle.mockReturnValue(true);
    mockListCodexSessionFileStates.mockReturnValue([]);
    mockListCodexSessionFileStatesByPaths.mockReturnValue([]);
    mockListCodexSessionFileInfos.mockResolvedValue([]);
    mockClassifyCodexSessionFileStatus.mockReturnValue("new");
    mockReadCodexSessionLimitSnapshotsFromAppend.mockResolvedValue({
      snapshots: [],
      parsedOffset: 0,
      pendingTail: "",
    });
    mockListCodexLimitHeadScopesByFilePaths.mockReturnValue([]);
    mockPruneCodexLimitRowsBeforeObservedAt.mockReturnValue({
      deletedScopes: [],
      headRowsDeleted: 0,
      historyRowsDeleted: 0,
    });
    mockPruneStaleCodexSessionIndexRows.mockReturnValue({
      sessionRowsDeleted: 0,
      fileRowsDeleted: 0,
      linkedRowsRetained: 0,
    });
    mockListProjects.mockReturnValue([]);
    mockListRuntimeProfileResponses.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts once, schedules non-blocking head warm-up, and schedules idle backfill", async () => {
    const { createCodexIndexService } = await loadService();
    const service = createCodexIndexService({
      headFileLimit: 3,
      backfillIntervalMs: 1000,
    });

    await service.start();
    await service.start();

    expect(service.isRunning()).toBe(true);
    expect(mockListCodexSessionFileInfos).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();
    expect(mockListCodexSessionFileInfos).toHaveBeenCalledWith({
      limitNewest: 3,
      modifiedAfterMs: expect.any(Number),
    });

    vi.advanceTimersByTime(1000);
    await vi.runOnlyPendingTimersAsync();
    expect(mockListCodexSessionFileInfos).toHaveBeenCalledWith({
      modifiedAfterMs: expect.any(Number),
    });
  });

  it("head reconcile scans only newest files and reads prior state by those paths", async () => {
    const { createCodexIndexService } = await loadService();
    const fileInfo = {
      filePath: "/tmp/codex/head.jsonl",
      birthtimeMs: 100,
      mtimeMs: 200,
      size: 300,
    };
    mockListCodexSessionFileInfos.mockResolvedValue([fileInfo]);
    mockReadCodexSessionMetaFromFile.mockResolvedValue({
      id: "session-head",
      model: "gpt-5.4",
      prompt: "Prompt",
      cwd: "/tmp/project",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:01.000Z",
      filePath: fileInfo.filePath,
    });

    const service = createCodexIndexService({ headFileLimit: 1 });
    await service.runReconcileOnce("manual-head", "head");

    expect(mockListCodexSessionFileInfos).toHaveBeenCalledWith({
      limitNewest: 1,
      modifiedAfterMs: expect.any(Number),
    });
    expect(mockListCodexSessionFileStatesByPaths).toHaveBeenCalledWith([fileInfo.filePath]);
    expect(mockListCodexSessionFileStates).not.toHaveBeenCalled();
    expect(mockDeleteCodexSessionsByFilePaths).not.toHaveBeenCalled();
    expect(mockDeleteCodexSessionFilesByFilePaths).not.toHaveBeenCalled();
    expect(mockDeleteCodexLimitHeadsByFilePaths).not.toHaveBeenCalled();
    expect(mockDeleteCodexLimitHistoryByFilePaths).not.toHaveBeenCalled();
  });

  it("backfill skips filesystem and SQLite work while the API is busy", async () => {
    const { createCodexIndexService } = await loadService();
    mockIsApiIdle.mockReturnValue(false);

    const service = createCodexIndexService({ minIdleMs: 1000 });
    const summary = await service.runReconcileOnce("manual-backfill", "backfill");

    expect(summary.scannedFiles).toBe(0);
    expect(summary.skippedForLoad).toBe(true);
    expect(mockListCodexSessionFileInfos).not.toHaveBeenCalled();
    expect(mockListCodexSessionFileStates).not.toHaveBeenCalled();
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
        mtimeMs: Date.parse("2026-04-23T00:00:00.000Z"),
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
    expect(mockDeleteCodexSessionFilesByFilePaths).toHaveBeenCalledWith([
      "/tmp/codex/missing.jsonl",
    ]);
    expect(mockDeleteCodexLimitHeadsByFilePaths).toHaveBeenCalledWith(["/tmp/codex/missing.jsonl"]);
    expect(mockDeleteCodexLimitHistoryByFilePaths).toHaveBeenCalledWith([
      "/tmp/codex/missing.jsonl",
    ]);
    expect(mockUpsertCodexSessionFiles).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "/tmp/codex/missing.jsonl",
          missing: true,
        }),
      ]),
    );
  });

  it("backfill scans only the Codex usage window and prunes stale unlinked index rows", async () => {
    const { createCodexIndexService } = await loadService();
    const oldRow = {
      filePath: "/tmp/codex/old-linked.jsonl",
      sessionId: "old-linked",
      sizeBytes: 100,
      mtimeMs: 100,
      parsedOffset: 100,
      pendingTail: "",
      missing: false,
      importVersion: 1,
      lastSeenAt: "2026-04-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };
    const scannedFile = {
      filePath: "/tmp/codex/recent.jsonl",
      birthtimeMs: 1000,
      mtimeMs: 2000,
      size: 300,
    };
    mockListCodexSessionFileStates.mockReturnValue([oldRow]);
    mockListCodexSessionFileInfos.mockResolvedValue([scannedFile]);
    mockPruneCodexLimitRowsBeforeObservedAt.mockReturnValue({
      deletedScopes: [
        {
          headKey: "old-head",
          projectRoot: "/tmp/project-1",
          observedAt: "2026-04-01T00:00:00.000Z",
          filePath: "/tmp/codex/old-linked.jsonl",
        },
      ],
      headRowsDeleted: 1,
      historyRowsDeleted: 2,
    });
    mockPruneStaleCodexSessionIndexRows.mockReturnValue({
      sessionRowsDeleted: 1,
      fileRowsDeleted: 1,
      linkedRowsRetained: 1,
    });
    mockDeleteCodexLimitHeadsByFilePaths.mockReturnValue(0);
    mockDeleteCodexLimitHistoryByFilePaths.mockReturnValue(0);

    const service = createCodexIndexService({ usageScanWindowDays: 7 });
    const summary = await service.runReconcileOnce("manual", "backfill");

    expect(mockListCodexSessionFileInfos).toHaveBeenCalledWith({
      modifiedAfterMs: expect.any(Number),
    });
    expect(mockDeleteCodexSessionsByFilePaths).not.toHaveBeenCalledWith([
      "/tmp/codex/old-linked.jsonl",
    ]);
    expect(mockPruneCodexLimitRowsBeforeObservedAt).toHaveBeenCalledWith(expect.any(String));
    expect(mockPruneStaleCodexSessionIndexRows).toHaveBeenCalledWith({
      mtimeBeforeMs: expect.any(Number),
    });
    expect(summary.headRowsDeleted).toBe(1);
    expect(summary.historyRowsDeleted).toBe(2);
  });

  it("notifies visible project runtime profiles when stale limit heads are deleted without replacements", async () => {
    const { createCodexIndexService } = await loadService();
    mockListCodexSessionFileStates.mockReturnValue([
      {
        filePath: "/tmp/project-1/.codex/sessions/deleted.jsonl",
        sessionId: "session-deleted",
        sizeBytes: 100,
        mtimeMs: Date.parse("2026-04-23T00:00:00.000Z"),
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
    expect(mockLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "appended",
        parsedBytes: 204,
      }),
      "Parsed Codex appended session range",
    );
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
    expect(mockLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rewrite",
        pendingTailBytes: 13,
      }),
      "Parsed Codex full session range with cursor state",
    );
    expect(mockLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        staleFileCount: 1,
      }),
      "Deleted stale Codex limit rows for changed files",
    );
    const debugMessages = mockLog.debug.mock.calls
      .map((call) => call[1])
      .filter((message): message is string => typeof message === "string");
    const developerMarkerPattern = new RegExp(String.raw`\[${"FIX"}:|^DEBUG `, "m");
    expect(debugMessages.join("\n")).not.toMatch(developerMarkerPattern);
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

  it("prunes retention only for touched limit heads", async () => {
    const { createCodexIndexService } = await loadService();
    mockBuildCodexLimitHeadKey.mockReturnValue("head-key-touched");
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

    const service = createCodexIndexService({ historyRetentionPerHead: 3 });
    await service.runReconcileOnce("manual");

    expect(mockPruneCodexLimitHistoryByHead).toHaveBeenCalledWith({
      headKey: "head-key-touched",
      keepLatest: 3,
    });
    expect(mockPruneCodexLimitHistoryRetention).not.toHaveBeenCalled();
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
