import {
  appendCodexLimitHistory,
  buildCodexLimitHeadKey,
  deleteCodexLimitHeadsByFilePaths,
  deleteCodexLimitHistoryByFilePaths,
  deleteCodexSessionFilesByFilePaths,
  deleteCodexSessionsByFilePaths,
  listCodexLimitHeadScopesByFilePaths,
  listCodexSessionFileStates,
  listCodexSessionFileStatesByPaths,
  listProjects,
  listRuntimeProfileResponses,
  pruneCodexLimitHistoryByHead,
  pruneCodexLimitRowsBeforeObservedAt,
  pruneStaleCodexSessionIndexRows,
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
import { isApiIdle } from "../middleware/apiLoad.js";
import { invalidateCodexOverlayCache } from "./codexOverlayCache.js";
import { notifyRuntimeLimitProjectUpdate } from "./runtime.js";

const log = logger("api-codex-index");

const DEFAULT_RUNTIME_ID = "codex";
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_BACKFILL_INTERVAL_MS = 10 * 60_000;
const DEFAULT_HISTORY_RETENTION_PER_HEAD = 20;
const DEFAULT_IMPORT_VERSION = 1;
const DEFAULT_HEAD_FILE_LIMIT = 200;
const DEFAULT_HEAD_TIME_BUDGET_MS = 150;
const DEFAULT_BACKFILL_SLICE_MS = 30;
const DEFAULT_BACKFILL_FILES_PER_SLICE = 20;
const DEFAULT_MIN_IDLE_MS = 1000;
const DEFAULT_HEAD_WARMUP_DELAY_MS = 0;
const DEFAULT_IDLE_RETRY_MS = 250;
const DEFAULT_DB_FLUSH_BATCH_SIZE = 20;
const DEFAULT_USAGE_SCAN_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
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
  skippedForLoad?: boolean;
  truncated?: boolean;
}

export type CodexIndexReconcileMode = "head" | "backfill";

export interface CodexIndexService {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  runReconcileOnce(
    reason?: string,
    mode?: CodexIndexReconcileMode,
  ): Promise<CodexIndexReconcileSummary>;
}

export interface CreateCodexIndexServiceOptions {
  runtimeId?: string;
  providerId?: string;
  reconcileIntervalMs?: number;
  backfillIntervalMs?: number;
  headFileLimit?: number;
  headTimeBudgetMs?: number;
  backfillSliceMs?: number;
  backfillFilesPerSlice?: number;
  minIdleMs?: number;
  headWarmupDelayMs?: number;
  idleRetryMs?: number;
  dbFlushBatchSize?: number;
  historyRetentionPerHead?: number;
  importVersion?: number;
  usageScanWindowDays?: number;
}

export function createCodexIndexService(
  options: CreateCodexIndexServiceOptions = {},
): CodexIndexService {
  const runtimeId = options.runtimeId ?? DEFAULT_RUNTIME_ID;
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const backfillIntervalMs = readPositiveInteger(
    options.backfillIntervalMs ?? options.reconcileIntervalMs,
    DEFAULT_BACKFILL_INTERVAL_MS,
  );
  const headFileLimit = readPositiveInteger(options.headFileLimit, DEFAULT_HEAD_FILE_LIMIT);
  const headTimeBudgetMs = readPositiveInteger(
    options.headTimeBudgetMs,
    DEFAULT_HEAD_TIME_BUDGET_MS,
  );
  const backfillSliceMs = readPositiveInteger(options.backfillSliceMs, DEFAULT_BACKFILL_SLICE_MS);
  const backfillFilesPerSlice = readPositiveInteger(
    options.backfillFilesPerSlice,
    DEFAULT_BACKFILL_FILES_PER_SLICE,
  );
  const minIdleMs = readPositiveInteger(options.minIdleMs, DEFAULT_MIN_IDLE_MS);
  const headWarmupDelayMs = Math.max(
    0,
    Math.trunc(options.headWarmupDelayMs ?? DEFAULT_HEAD_WARMUP_DELAY_MS),
  );
  const idleRetryMs = readPositiveInteger(options.idleRetryMs, DEFAULT_IDLE_RETRY_MS);
  const dbFlushBatchSize = readPositiveInteger(
    options.dbFlushBatchSize,
    DEFAULT_DB_FLUSH_BATCH_SIZE,
  );
  const usageScanWindowDays = readPositiveInteger(
    options.usageScanWindowDays,
    DEFAULT_USAGE_SCAN_WINDOW_DAYS,
  );
  const usageScanWindowMs = usageScanWindowDays * DAY_MS;
  const historyRetentionPerHead =
    options.historyRetentionPerHead ?? DEFAULT_HISTORY_RETENTION_PER_HEAD;
  const importVersion = options.importVersion ?? DEFAULT_IMPORT_VERSION;

  let running = false;
  let headWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  let backfillTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<CodexIndexReconcileSummary> | null = null;

  const scheduleHeadWarmupSoon = (delayMs = headWarmupDelayMs) => {
    if (!running) {
      return;
    }
    if (headWarmupTimer) {
      clearTimeout(headWarmupTimer);
    }
    headWarmupTimer = setTimeout(() => {
      headWarmupTimer = null;
      void runReconcileOnce("head-warmup", "head")
        .then((summary) => {
          if (running && (summary.skippedForLoad || summary.truncated)) {
            scheduleHeadWarmupSoon(idleRetryMs);
          }
        })
        .catch((error) => {
          log.warn({ err: error, runtimeId, providerId }, "Codex head warm-up failed");
          if (running) {
            scheduleHeadWarmupSoon(idleRetryMs);
          }
        });
    }, delayMs);
  };

  const scheduleIdleBackfillLater = (delayMs = backfillIntervalMs) => {
    if (!running) {
      return;
    }
    if (backfillTimer) {
      clearTimeout(backfillTimer);
    }
    backfillTimer = setTimeout(() => {
      backfillTimer = null;
      void runReconcileOnce("idle-backfill", "backfill")
        .then((summary) => {
          scheduleIdleBackfillLater(
            summary.skippedForLoad || summary.truncated ? idleRetryMs : backfillIntervalMs,
          );
        })
        .catch((error) => {
          log.warn({ err: error, runtimeId, providerId }, "Codex idle backfill failed");
          scheduleIdleBackfillLater(idleRetryMs);
        });
    }, delayMs);
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

  const emptySummary = (
    reason: string,
    extra: Pick<CodexIndexReconcileSummary, "skippedForLoad" | "truncated"> = {},
  ): CodexIndexReconcileSummary => ({
    reason,
    scannedFiles: 0,
    changedFiles: 0,
    missingFiles: 0,
    sessionRowsUpserted: 0,
    fileRowsUpserted: 0,
    headRowsUpserted: 0,
    historyRowsAppended: 0,
    headRowsDeleted: 0,
    historyRowsDeleted: 0,
    ...extra,
  });

  const yieldToEventLoop = async (): Promise<void> => {
    await Promise.resolve();
  };

  const shouldPauseForLoad = (): boolean => !isApiIdle(minIdleMs);

  const writeRowsInBatches = async <T>(
    rows: T[],
    writer: (chunk: T[]) => number,
  ): Promise<{ written: number; interrupted: boolean }> => {
    let written = 0;
    for (let i = 0; i < rows.length; i += dbFlushBatchSize) {
      if (shouldPauseForLoad()) {
        return { written, interrupted: true };
      }
      written += writer(rows.slice(i, i + dbFlushBatchSize));
      await yieldToEventLoop();
    }
    return { written, interrupted: false };
  };

  const reconcile = async (
    reason: string,
    mode: CodexIndexReconcileMode,
  ): Promise<CodexIndexReconcileSummary> => {
    const startedAt = Date.now();
    if (shouldPauseForLoad()) {
      log.debug({ reason, mode, minIdleMs }, "Codex index reconcile skipped due API load");
      return emptySummary(reason, { skippedForLoad: true });
    }

    const nowIso = new Date().toISOString();
    const usageScanCutoffMs = Math.max(0, Date.now() - usageScanWindowMs);
    const usageScanCutoffIso = new Date(usageScanCutoffMs).toISOString();
    const authIdentity = await getCodexAuthIdentity();
    const fallbackAccountFingerprint = buildCodexAuthFingerprint(authIdentity);

    if (shouldPauseForLoad()) {
      log.debug({ reason, mode, minIdleMs }, "Codex index reconcile paused before file scan");
      return emptySummary(reason, { skippedForLoad: true });
    }

    const files = await listCodexSessionFileInfos(
      mode === "head"
        ? { limitNewest: headFileLimit, modifiedAfterMs: usageScanCutoffMs }
        : { modifiedAfterMs: usageScanCutoffMs },
    );
    const previousStates =
      mode === "head"
        ? listCodexSessionFileStatesByPaths(files.map((file) => file.filePath))
        : listCodexSessionFileStates();
    const previousByPath = new Map(previousStates.map((row) => [row.filePath, row]));
    const currentPathSet = new Set(files.map((file) => file.filePath));

    const sessionRows: UpsertCodexSessionInput[] = [];
    const fileRows: UpsertCodexSessionFileInput[] = [];
    const headRows: UpsertCodexLimitHeadInput[] = [];
    const historyRows: AppendCodexLimitHistoryInput[] = [];
    const staleLimitFilePaths: string[] = [];

    let changedFiles = 0;
    let truncated = false;
    let skippedForLoad = false;

    for (const fileInfo of files) {
      if (shouldPauseForLoad()) {
        skippedForLoad = true;
        break;
      }
      if (mode === "head" && Date.now() - startedAt >= headTimeBudgetMs) {
        truncated = true;
        break;
      }
      if (
        mode === "backfill" &&
        (changedFiles >= backfillFilesPerSlice || Date.now() - startedAt >= backfillSliceMs)
      ) {
        truncated = true;
        break;
      }

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
      if (status !== "appended" && previous && !previous.missing) {
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
          ? "Parsed Codex appended session range"
          : "Parsed Codex full session range with cursor state",
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

    const remainingBackfillFileBudget = Math.max(0, backfillFilesPerSlice - changedFiles);
    const missingPaths =
      mode === "backfill" && remainingBackfillFileBudget > 0
        ? previousStates
            .filter(
              (row) =>
                !row.missing &&
                row.mtimeMs >= usageScanCutoffMs &&
                !currentPathSet.has(row.filePath),
            )
            .slice(0, remainingBackfillFileBudget)
            .map((row) => row.filePath)
        : [];
    if (missingPaths.length > 0) {
      changedFiles += missingPaths.length;
      staleLimitFilePaths.push(...missingPaths);
    }

    const uniqueStaleLimitFilePaths = [...new Set(staleLimitFilePaths)];
    if (skippedForLoad || shouldPauseForLoad()) {
      return {
        ...emptySummary(reason, { skippedForLoad: true, truncated }),
        scannedFiles: files.length,
        changedFiles,
        missingFiles: missingPaths.length,
      };
    }

    const deletedLimitScopes =
      uniqueStaleLimitFilePaths.length > 0
        ? listCodexLimitHeadScopesByFilePaths(uniqueStaleLimitFilePaths)
        : [];
    if (uniqueStaleLimitFilePaths.length > 0) {
      await yieldToEventLoop();
    }
    const sessionRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexSessionsByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (sessionRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const sessionFileRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexSessionFilesByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (sessionFileRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const headRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHeadsByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (headRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const staleHistoryRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHistoryByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (staleHistoryRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const oldLimitPrune =
      mode === "backfill"
        ? pruneCodexLimitRowsBeforeObservedAt(usageScanCutoffIso)
        : { deletedScopes: [], headRowsDeleted: 0, historyRowsDeleted: 0 };
    if (oldLimitPrune.deletedScopes.length > 0) {
      deletedLimitScopes.push(...oldLimitPrune.deletedScopes);
    }
    const oldSessionPrune =
      mode === "backfill"
        ? pruneStaleCodexSessionIndexRows({ mtimeBeforeMs: usageScanCutoffMs })
        : { sessionRowsDeleted: 0, fileRowsDeleted: 0, linkedRowsRetained: 0 };
    if (
      oldLimitPrune.headRowsDeleted > 0 ||
      oldLimitPrune.historyRowsDeleted > 0 ||
      oldSessionPrune.sessionRowsDeleted > 0 ||
      oldSessionPrune.fileRowsDeleted > 0
    ) {
      await yieldToEventLoop();
    }
    if (uniqueStaleLimitFilePaths.length > 0) {
      log.debug(
        {
          reason,
          staleFileCount: uniqueStaleLimitFilePaths.length,
          deletedScopeCount: deletedLimitScopes.length,
          sessionFileRowsDeleted,
          headRowsDeleted,
          historyRowsDeleted: staleHistoryRowsDeleted,
        },
        "Deleted stale Codex limit rows for changed files",
      );
    }

    const sessionWrite = await writeRowsInBatches(sessionRows, upsertCodexSessions);
    const fileWrite = await writeRowsInBatches(fileRows, upsertCodexSessionFiles);
    const headWrite = await writeRowsInBatches(headRows, upsertCodexLimitHeads);
    const historyWrite = await writeRowsInBatches(historyRows, appendCodexLimitHistory);
    const interrupted =
      sessionWrite.interrupted ||
      fileWrite.interrupted ||
      headWrite.interrupted ||
      historyWrite.interrupted;
    const sessionRowsUpserted = sessionWrite.written;
    const fileRowsUpserted = fileWrite.written;
    const headRowsUpserted = headWrite.written;
    const historyRowsAppended = historyWrite.written;
    let retainedHistoryRowsDeleted = 0;
    if (!interrupted && historyRetentionPerHead > 0) {
      const touchedHeadKeys = new Set(
        historyRows
          .map((row) => row.headKey)
          .filter((headKey): headKey is string => Boolean(headKey)),
      );
      for (const headKey of touchedHeadKeys) {
        if (shouldPauseForLoad()) {
          skippedForLoad = true;
          break;
        }
        retainedHistoryRowsDeleted += pruneCodexLimitHistoryByHead({
          headKey,
          keepLatest: historyRetentionPerHead,
        });
        await yieldToEventLoop();
      }
    }
    const totalHeadRowsDeleted = headRowsDeleted + oldLimitPrune.headRowsDeleted;
    const historyRowsDeleted =
      staleHistoryRowsDeleted + oldLimitPrune.historyRowsDeleted + retainedHistoryRowsDeleted;

    const summary: CodexIndexReconcileSummary = {
      reason,
      scannedFiles: files.length,
      changedFiles,
      missingFiles: missingPaths.length,
      sessionRowsUpserted,
      fileRowsUpserted,
      headRowsUpserted,
      historyRowsAppended,
      headRowsDeleted: totalHeadRowsDeleted,
      historyRowsDeleted,
      ...(skippedForLoad || interrupted ? { skippedForLoad: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };

    if (!summary.skippedForLoad && !interrupted) {
      upsertCodexIndexCursor({
        cursorKey: "codex:index:last_reconcile",
        cursorValue: nowIso,
        cursorJson: {
          runtimeId,
          providerId,
          importVersion,
          durationMs: Date.now() - startedAt,
          mode,
          ...summary,
        },
        updatedAt: nowIso,
      });
    }
    if (summary.headRowsUpserted > 0 || summary.headRowsDeleted > 0) {
      invalidateCodexOverlayCache();
    }
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
        staleSessionRowsDeleted: oldSessionPrune.sessionRowsDeleted,
        staleSessionFileRowsDeleted: oldSessionPrune.fileRowsDeleted,
        staleLinkedSessionRowsRetained: oldSessionPrune.linkedRowsRetained,
      },
      "Codex index reconcile finished",
    );

    return summary;
  };

  const runReconcileOnce = async (
    reason = "manual",
    mode: CodexIndexReconcileMode = "backfill",
  ): Promise<CodexIndexReconcileSummary> => {
    if (inFlight) {
      log.debug({ reason, mode }, "Codex index reconcile skipped because another pass is running");
      return inFlight;
    }
    inFlight = reconcile(reason, mode).finally(() => {
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
    scheduleHeadWarmupSoon();
    scheduleIdleBackfillLater();
    log.info(
      { runtimeId, providerId, headFileLimit, backfillIntervalMs, minIdleMs, usageScanWindowDays },
      "Codex indexer idle reconcile loop started",
    );
  };

  const stop = async (): Promise<void> => {
    if (!running) {
      log.info({ runtimeId, providerId }, "Codex indexer already stopped");
      return;
    }

    running = false;
    if (headWarmupTimer) {
      clearTimeout(headWarmupTimer);
      headWarmupTimer = null;
    }
    if (backfillTimer) {
      clearTimeout(backfillTimer);
      backfillTimer = null;
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
