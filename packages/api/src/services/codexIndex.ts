import {
  appendCodexLimitHistory,
  buildCodexLimitHeadKey,
  deleteCodexLimitHeadsByFilePaths,
  deleteCodexLimitHistoryByFilePaths,
  deleteCodexSessionsByFilePaths,
  listCodexLimitHeadScopesByFilePaths,
  listCodexSessionFileStates,
  listProjects,
  listRuntimeProfileResponses,
  pruneCodexLimitHistoryRetention,
  upsertCodexIndexCursor,
  upsertCodexLimitHeads,
  upsertCodexSessionFiles,
  upsertCodexSessions,
  type AppendCodexLimitHistoryInput,
  type UpsertCodexLimitHeadInput,
  type UpsertCodexSessionFileInput,
  type UpsertCodexSessionInput,
  type CodexLimitHeadScopeRow,
} from "@aif/data";
import {
  buildCodexAuthFingerprint,
  classifyCodexSessionFileStatus,
  getCodexAuthIdentity,
  listCodexSessionFileInfos,
  normalizeCodexProjectPath,
  readCodexSessionLimitSnapshotsFromAppend,
  readCodexSessionMetaFromFile,
  readCodexSnapshotAccountFingerprint,
  type CodexSessionFileInfo,
  type RuntimeLimitSnapshot,
} from "@aif/runtime";
import { logger } from "@aif/shared";
import { notifyRuntimeLimitProjectUpdate } from "./runtime.js";

const log = logger("api-codex-index");

const DEFAULT_RUNTIME_ID = "codex";
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_HISTORY_RETENTION_PER_HEAD = 20;
const DEFAULT_IMPORT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readSnapshotLimitId(snapshot: RuntimeLimitSnapshot): string {
  const providerMeta = isRecord(snapshot.providerMeta) ? snapshot.providerMeta : null;
  const value = providerMeta?.limitId;
  return typeof value === "string" && value.trim().length > 0 ? value : "codex";
}

function toFileState(
  fileInfo: CodexSessionFileInfo,
  parsedOffset: number,
  pendingTail = "",
): UpsertCodexSessionFileInput {
  return {
    filePath: fileInfo.filePath,
    sessionId: null,
    sizeBytes: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    parsedOffset,
    pendingTail,
    missing: false,
    importVersion: DEFAULT_IMPORT_VERSION,
  };
}

function normalizeProjectRoot(projectRoot: string | null | undefined): string | null {
  return normalizeCodexProjectPath(projectRoot);
}

function isLocalCodexRuntimeProfile(profile: {
  runtimeId: string;
  transport?: string | null;
}): boolean {
  return (
    profile.runtimeId === "codex" && (profile.transport === "sdk" || profile.transport === "cli")
  );
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export interface CodexIndexReconcileSummary {
  reason: string;
  scannedFiles: number;
  changedFiles: number;
  missingFiles: number;
  sessionRowsUpserted: number;
  fileRowsUpserted: number;
  headRowsUpserted: number;
  historyRowsAppended: number;
  headRowsDeleted: number;
  historyRowsDeleted: number;
}

export interface CodexIndexService {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  runReconcileOnce(reason?: string): Promise<CodexIndexReconcileSummary>;
}

export interface CreateCodexIndexServiceOptions {
  runtimeId?: string;
  providerId?: string;
  reconcileIntervalMs?: number;
  historyRetentionPerHead?: number;
  importVersion?: number;
}

export function createCodexIndexService(
  options: CreateCodexIndexServiceOptions = {},
): CodexIndexService {
  const runtimeId = options.runtimeId ?? DEFAULT_RUNTIME_ID;
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const historyRetentionPerHead =
    options.historyRetentionPerHead ?? DEFAULT_HISTORY_RETENTION_PER_HEAD;
  const importVersion = options.importVersion ?? DEFAULT_IMPORT_VERSION;

  let running = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<CodexIndexReconcileSummary> | null = null;

  const scheduleNext = () => {
    if (!running) {
      return;
    }
    reconcileTimer = setTimeout(() => {
      void runReconcileOnce("scheduled").finally(() => {
        scheduleNext();
      });
    }, reconcileIntervalMs);
  };

  const notifyVisibleProjectsWithCodexLimitUpdate = (input: {
    headRows: UpsertCodexLimitHeadInput[];
    deletedScopes: CodexLimitHeadScopeRow[];
    summary: CodexIndexReconcileSummary;
    cursorTimestamp: string;
  }): void => {
    const hasUpsertedHeads = input.summary.headRowsUpserted > 0 && input.headRows.length > 0;
    const hasDeletedHeads = input.summary.headRowsDeleted > 0 && input.deletedScopes.length > 0;
    if (!hasUpsertedHeads && !hasDeletedHeads) {
      return;
    }

    const allProjects = listProjects();
    if (allProjects.length === 0) {
      return;
    }

    const projectIds = new Set<string>();
    const touchedRoots = new Set<string>();
    let includesGlobalScope = false;

    for (const row of input.headRows) {
      const projectRoot = normalizeProjectRoot(row.projectRoot);
      if (!projectRoot) {
        includesGlobalScope = true;
        break;
      }
      touchedRoots.add(projectRoot);
    }
    for (const scope of input.deletedScopes) {
      const projectRoot = normalizeProjectRoot(scope.projectRoot);
      if (!projectRoot) {
        includesGlobalScope = true;
        break;
      }
      touchedRoots.add(projectRoot);
    }

    if (includesGlobalScope) {
      for (const project of allProjects) {
        projectIds.add(project.id);
      }
    } else if (touchedRoots.size > 0) {
      for (const project of allProjects) {
        if (touchedRoots.has(project.rootPath)) {
          projectIds.add(project.id);
        }
      }
    }

    if (projectIds.size === 0) {
      return;
    }

    const observedAtValues = [
      ...input.headRows.map((row) => row.observedAt),
      ...input.deletedScopes.map((scope) => scope.observedAt),
    ];
    const latestObservedAt = observedAtValues.reduce<string | null>((latest, observedAt) => {
      if (!latest) return observedAt;
      return parseTimestampMs(observedAt) > parseTimestampMs(latest) ? observedAt : latest;
    }, null);
    const signature = [
      "codex-index",
      runtimeId,
      providerId,
      latestObservedAt ?? input.cursorTimestamp,
      String(input.summary.headRowsUpserted),
      String(input.summary.headRowsDeleted),
      String(input.summary.historyRowsDeleted),
    ].join(":");

    let profileBroadcastCount = 0;
    for (const projectId of projectIds) {
      const visibleProfiles = listRuntimeProfileResponses({
        projectId,
        includeGlobal: true,
        enabledOnly: true,
      }).filter(isLocalCodexRuntimeProfile);

      for (const profile of visibleProfiles) {
        notifyRuntimeLimitProjectUpdate({
          projectId,
          runtimeProfileId: profile.id,
          signature,
        });
        profileBroadcastCount += 1;
      }
    }

    log.debug(
      {
        runtimeId,
        providerId,
        affectedProjectCount: projectIds.size,
        profileBroadcastCount,
        headRowsUpserted: input.summary.headRowsUpserted,
        headRowsDeleted: input.summary.headRowsDeleted,
      },
      "Codex index reconcile notified project runtime-limit overlays",
    );
  };

  const reconcile = async (reason: string): Promise<CodexIndexReconcileSummary> => {
    const startedAt = Date.now();
    const nowIso = new Date().toISOString();
    const authIdentity = await getCodexAuthIdentity();
    const fallbackAccountFingerprint = buildCodexAuthFingerprint(authIdentity);
    const files = await listCodexSessionFileInfos();
    const previousStates = listCodexSessionFileStates();
    const previousByPath = new Map(previousStates.map((row) => [row.filePath, row]));
    const currentPathSet = new Set(files.map((file) => file.filePath));

    const sessionRows: UpsertCodexSessionInput[] = [];
    const fileRows: UpsertCodexSessionFileInput[] = [];
    const headRows: UpsertCodexLimitHeadInput[] = [];
    const historyRows: AppendCodexLimitHistoryInput[] = [];
    const staleLimitFilePaths: string[] = [];

    let changedFiles = 0;

    for (const fileInfo of files) {
      const previous = previousByPath.get(fileInfo.filePath);
      const status = classifyCodexSessionFileStatus({
        previous: previous
          ? {
              sizeBytes: previous.sizeBytes,
              mtimeMs: previous.mtimeMs,
              importVersion: previous.importVersion,
            }
          : null,
        current: fileInfo,
        importVersion,
      });

      if (status === "unchanged" && !previous?.missing) {
        continue;
      }
      changedFiles += 1;
      if (status !== "appended") {
        staleLimitFilePaths.push(fileInfo.filePath);
      }

      const sessionMeta = await readCodexSessionMetaFromFile(fileInfo);
      if (sessionMeta) {
        sessionRows.push({
          sessionId: sessionMeta.id,
          filePath: fileInfo.filePath,
          title: sessionMeta.prompt ?? null,
          projectRoot: sessionMeta.cwd ?? null,
          accountFingerprint: fallbackAccountFingerprint,
          sourceCreatedAt: sessionMeta.createdAt,
          sourceUpdatedAt: sessionMeta.updatedAt,
          messageCount: 0,
          previewText: sessionMeta.prompt ?? null,
          sizeBytes: fileInfo.size,
          mtimeMs: fileInfo.mtimeMs,
          lastIndexedAt: nowIso,
        });
      }

      const appendStartOffset =
        status === "appended" ? (previous?.parsedOffset ?? previous?.sizeBytes ?? 0) : 0;
      const appendPendingTail = status === "appended" ? (previous?.pendingTail ?? "") : "";
      const snapshotParseResult = await readCodexSessionLimitSnapshotsFromAppend({
        fileInfo,
        startOffset: appendStartOffset,
        pendingTail: appendPendingTail,
        runtimeId,
        providerId,
        profileId: null,
        authIdentity,
      });
      const nextParsedOffset = snapshotParseResult.parsedOffset;
      const nextPendingTail = snapshotParseResult.pendingTail;
      const snapshots = snapshotParseResult.snapshots;
      log.debug(
        {
          reason,
          status,
          parsedBytes: Math.max(0, snapshotParseResult.parsedOffset - appendStartOffset),
          pendingTailBytes: snapshotParseResult.pendingTail.length,
          snapshotCount: snapshotParseResult.snapshots.length,
        },
        status === "appended"
          ? "DEBUG [FIX:codex-index-append] Parsed Codex appended session range"
          : "DEBUG [FIX:codex-index-full-range] Parsed Codex full session range with cursor state",
      );

      for (const snapshot of snapshots) {
        const accountFingerprint =
          readCodexSnapshotAccountFingerprint(snapshot) ?? fallbackAccountFingerprint;
        if (!accountFingerprint) {
          continue;
        }

        const limitId = readSnapshotLimitId(snapshot);
        const upsertRow: UpsertCodexLimitHeadInput = {
          accountFingerprint,
          projectRoot: sessionMeta?.cwd ?? null,
          limitId,
          model: sessionMeta?.model ?? null,
          source: "codex",
          snapshot,
          observedAt: snapshot.checkedAt,
          sessionId: sessionMeta?.id ?? null,
          filePath: fileInfo.filePath,
        };
        headRows.push(upsertRow);
        historyRows.push({
          ...upsertRow,
          headKey: buildCodexLimitHeadKey(upsertRow),
        });
      }

      const nextFileState = toFileState(fileInfo, nextParsedOffset, nextPendingTail);
      nextFileState.sessionId = sessionMeta?.id ?? previous?.sessionId ?? null;
      nextFileState.missing = false;
      nextFileState.importVersion = importVersion;
      nextFileState.lastSeenAt = nowIso;
      fileRows.push(nextFileState);
    }

    const missingPaths = previousStates
      .filter((row) => !currentPathSet.has(row.filePath))
      .map((row) => row.filePath);
    if (missingPaths.length > 0) {
      changedFiles += missingPaths.length;
      const missingRows = previousStates
        .filter((row) => missingPaths.includes(row.filePath))
        .map<UpsertCodexSessionFileInput>((row) => ({
          filePath: row.filePath,
          sessionId: row.sessionId,
          sizeBytes: row.sizeBytes,
          mtimeMs: row.mtimeMs,
          parsedOffset: row.parsedOffset,
          pendingTail: row.pendingTail,
          missing: true,
          importVersion: row.importVersion,
          lastSeenAt: nowIso,
        }));
      fileRows.push(...missingRows);
      deleteCodexSessionsByFilePaths(missingPaths);
      staleLimitFilePaths.push(...missingPaths);
    }

    const uniqueStaleLimitFilePaths = [...new Set(staleLimitFilePaths)];
    const deletedLimitScopes =
      uniqueStaleLimitFilePaths.length > 0
        ? listCodexLimitHeadScopesByFilePaths(uniqueStaleLimitFilePaths)
        : [];
    const headRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHeadsByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    const staleHistoryRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHistoryByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (uniqueStaleLimitFilePaths.length > 0) {
      log.debug(
        {
          reason,
          staleFileCount: uniqueStaleLimitFilePaths.length,
          deletedScopeCount: deletedLimitScopes.length,
          headRowsDeleted,
          historyRowsDeleted: staleHistoryRowsDeleted,
        },
        "DEBUG [FIX:codex-index-cleanup] Deleted stale Codex limit rows for changed files",
      );
    }

    const sessionRowsUpserted = sessionRows.length > 0 ? upsertCodexSessions(sessionRows) : 0;
    const fileRowsUpserted = fileRows.length > 0 ? upsertCodexSessionFiles(fileRows) : 0;
    const headRowsUpserted = headRows.length > 0 ? upsertCodexLimitHeads(headRows) : 0;
    const historyRowsAppended = historyRows.length > 0 ? appendCodexLimitHistory(historyRows) : 0;
    const retainedHistoryRowsDeleted =
      historyRetentionPerHead > 0 ? pruneCodexLimitHistoryRetention(historyRetentionPerHead) : 0;
    const historyRowsDeleted = staleHistoryRowsDeleted + retainedHistoryRowsDeleted;

    const summary: CodexIndexReconcileSummary = {
      reason,
      scannedFiles: files.length,
      changedFiles,
      missingFiles: missingPaths.length,
      sessionRowsUpserted,
      fileRowsUpserted,
      headRowsUpserted,
      historyRowsAppended,
      headRowsDeleted,
      historyRowsDeleted,
    };

    upsertCodexIndexCursor({
      cursorKey: "codex:index:last_reconcile",
      cursorValue: nowIso,
      cursorJson: {
        runtimeId,
        providerId,
        importVersion,
        durationMs: Date.now() - startedAt,
        ...summary,
      },
      updatedAt: nowIso,
    });
    notifyVisibleProjectsWithCodexLimitUpdate({
      headRows,
      deletedScopes: deletedLimitScopes,
      summary,
      cursorTimestamp: nowIso,
    });

    log.debug(
      {
        reason,
        runtimeId,
        providerId,
        durationMs: Date.now() - startedAt,
        scannedFiles: summary.scannedFiles,
        changedFiles: summary.changedFiles,
        missingFiles: summary.missingFiles,
        sessionRowsUpserted: summary.sessionRowsUpserted,
        fileRowsUpserted: summary.fileRowsUpserted,
        headRowsUpserted: summary.headRowsUpserted,
        historyRowsAppended: summary.historyRowsAppended,
        headRowsDeleted: summary.headRowsDeleted,
        historyRowsDeleted: summary.historyRowsDeleted,
      },
      "Codex index reconcile finished",
    );

    return summary;
  };

  const runReconcileOnce = async (reason = "manual"): Promise<CodexIndexReconcileSummary> => {
    if (inFlight) {
      log.debug({ reason }, "Codex index reconcile skipped because another pass is running");
      return inFlight;
    }
    inFlight = reconcile(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const start = async (): Promise<void> => {
    if (running) {
      log.info({ runtimeId, providerId }, "Codex indexer already started");
      return;
    }

    running = true;
    log.info({ runtimeId, providerId }, "Codex indexer start");
    try {
      await runReconcileOnce("warmup");
      log.info({ runtimeId, providerId }, "Codex indexer warm-up done");
    } catch (error) {
      log.error({ err: error, runtimeId, providerId }, "Codex indexer warm-up failed");
    }
    scheduleNext();
    log.info(
      { runtimeId, providerId, reconcileIntervalMs },
      "Codex indexer reconcile loop started",
    );
  };

  const stop = async (): Promise<void> => {
    if (!running) {
      log.info({ runtimeId, providerId }, "Codex indexer already stopped");
      return;
    }

    running = false;
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    log.info({ runtimeId, providerId }, "Codex indexer stop requested");
    try {
      await inFlight;
    } catch (error) {
      log.warn(
        { err: error, runtimeId, providerId },
        "Codex indexer stopped after reconcile error",
      );
    } finally {
      log.info({ runtimeId, providerId }, "Codex indexer stopped");
    }
  };

  return {
    start,
    stop,
    isRunning: () => running,
    runReconcileOnce,
  };
}
