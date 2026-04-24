import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  RuntimeLimitSnapshot,
  RuntimeLimitStatus,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus as RuntimeLimitStatusEnum,
} from "../../types.js";
import { createRuntimeMemoryCache } from "../../cache.js";

/**
 * Codex SDK persists threads in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * This module reads persisted session metadata for the RuntimeAdapter session API.
 */

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const AUTH_FILE = join(homedir(), ".codex", "auth.json");
const SESSION_FILE_PATTERN =
  /(?:^|[/\\])rollout-[^/\\]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexSessionMeta {
  id: string;
  model?: string;
  prompt?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
}

export interface CodexSessionFileInfo {
  filePath: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}

export interface CodexIndexedFileState {
  sizeBytes: number;
  mtimeMs: number;
  importVersion: number;
}

export type CodexSessionFileStatus = "new" | "unchanged" | "appended" | "rewrite" | "missing";

export interface CodexAppendLimitSnapshotsResult {
  snapshots: RuntimeLimitSnapshot[];
  parsedOffset: number;
  pendingTail: string;
}

interface CodexSessionRateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexSessionCredits {
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface CodexSessionRateLimits {
  limit_id?: unknown;
  limit_name?: unknown;
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  plan_type?: unknown;
}

export interface CodexAuthIdentity {
  accountId: string | null;
  authMode: string | null;
  accountName: string | null;
  accountEmail: string | null;
  planType: string | null;
}

const DEFAULT_WARNING_THRESHOLD = 10;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const DEFAULT_CODEX_LIMIT_ID = "codex";
const SESSION_META_CACHE_TTL_MS = 30_000;
const SESSION_META_FILE_CACHE_TTL_MS = 300_000;
const SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS = 60_000;
const LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT = 50;
const LIMIT_SNAPSHOT_TAIL_CHUNK_BYTES = 64 * 1024;

const sessionMetasCache = createRuntimeMemoryCache<CodexSessionMeta[]>({
  defaultTtlMs: SESSION_META_CACHE_TTL_MS,
  maxSize: 1,
});
const sessionMetaByFileCache = createRuntimeMemoryCache<CodexSessionMeta>({
  defaultTtlMs: SESSION_META_FILE_CACHE_TTL_MS,
  maxSize: 20_000,
});
const sessionLimitSnapshotsCache = createRuntimeMemoryCache<RuntimeLimitSnapshot[]>({
  defaultTtlMs: SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS,
  maxSize: 512,
});
const latestLimitSnapshotsCache = createRuntimeMemoryCache<RuntimeLimitSnapshot[]>({
  defaultTtlMs: SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS,
  maxSize: 64,
});

function toIso(value: string | number | undefined): string {
  try {
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    // fall through
  }
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readModelIdentifier(
  value: Record<string, unknown> | null | undefined,
): string | undefined {
  return readString(value?.model) ?? readString(value?.model_slug) ?? readString(value?.modelId);
}

function readSnapshotLimitId(snapshot: RuntimeLimitSnapshot | null | undefined): string | null {
  const providerMeta = asRecord(snapshot?.providerMeta);
  return readString(providerMeta?.limitId) ?? null;
}

function applySnapshotProfileId(
  snapshot: RuntimeLimitSnapshot,
  profileId: string | null | undefined,
): RuntimeLimitSnapshot {
  const nextProfileId = profileId ?? null;
  return snapshot.profileId === nextProfileId
    ? snapshot
    : { ...snapshot, profileId: nextProfileId };
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  ...path: string[]
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)?.[segment];
    if (current == null) {
      return null;
    }
  }

  return readString(current) ?? null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  const rawToken = readString(token);
  if (!rawToken) {
    return null;
  }

  const parts = rawToken.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

export async function getCodexAuthIdentity(): Promise<CodexAuthIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(AUTH_FILE, "utf-8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = asRecord(parsedJson);
  if (!parsed) {
    return null;
  }

  const tokens = asRecord(parsed.tokens);
  const idTokenPayload = decodeJwtPayload(tokens?.id_token);
  const accessTokenPayload = decodeJwtPayload(tokens?.access_token);
  const accountId = readString(tokens?.account_id) ?? null;
  const authMode = readString(parsed.auth_mode) ?? null;
  const accountName =
    readNestedString(idTokenPayload, "name") ??
    readNestedString(accessTokenPayload, "name") ??
    null;
  const accountEmail =
    readNestedString(accessTokenPayload, "https://api.openai.com/profile", "email") ??
    readNestedString(idTokenPayload, "email") ??
    null;
  const planType =
    readNestedString(accessTokenPayload, "https://api.openai.com/auth", "chatgpt_plan_type") ??
    readNestedString(idTokenPayload, "https://api.openai.com/auth", "chatgpt_plan_type") ??
    null;

  if (!accountId && !authMode && !accountName && !accountEmail && !planType) {
    return null;
  }

  return {
    accountId,
    authMode,
    accountName,
    accountEmail,
    planType,
  };
}

export function buildCodexAuthFingerprint(
  identity: CodexAuthIdentity | null | undefined,
): string | null {
  if (!identity) {
    return null;
  }

  const accountId = identity.accountId?.trim().toLowerCase() ?? "";
  const accountEmail = identity.accountEmail?.trim().toLowerCase() ?? "";
  const accountName = identity.accountName?.trim().toLowerCase() ?? "";
  const authMode = identity.authMode?.trim().toLowerCase() ?? "";
  const planType = identity.planType?.trim().toLowerCase() ?? "";
  const stableValue = `${accountId}|${accountEmail}|${accountName}|${authMode}|${planType}`;
  if (!stableValue.replace(/\|/g, "")) {
    return null;
  }

  return createHash("sha256").update(stableValue).digest("hex");
}

export function readCodexSnapshotAccountFingerprint(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): string | null {
  const providerMeta = asRecord(snapshot?.providerMeta);
  const embedded = readString(providerMeta?.accountFingerprint);
  if (embedded) {
    return embedded;
  }

  return buildCodexAuthFingerprint({
    accountId: readString(providerMeta?.accountId) ?? null,
    authMode: readString(providerMeta?.authMode) ?? null,
    accountName: readString(providerMeta?.accountName) ?? null,
    accountEmail: readString(providerMeta?.accountEmail) ?? null,
    planType: readString(providerMeta?.planType) ?? null,
  });
}

function sessionIdFromFilePath(filePath: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(filePath);
  return match?.[1] ?? null;
}

function readDateMs(value: Date | number | undefined, fallbackMs: number): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : fallbackMs;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : fallbackMs;
}

export function normalizeCodexProjectPath(value: string | undefined | null): string | null {
  if (!value) return null;
  return value
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function normalizePath(value: string | undefined): string | null {
  return normalizeCodexProjectPath(value);
}

function normalizeSessionResetAt(value: unknown): string | null {
  const raw = readFiniteNumber(value);
  if (raw == null) return null;

  const targetMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    return null;
  }

  const date = new Date(targetMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toPercentRemaining(percentUsed: number | null): number | null {
  if (percentUsed == null) return null;
  return Math.max(0, Math.min(100, 100 - percentUsed));
}

function formatWindowName(windowMinutes: number | null): string | null {
  if (windowMinutes == null) return null;
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10080) return "7d";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

function buildRateLimitWindow(rawWindow: unknown) {
  const window = asRecord(rawWindow) as CodexSessionRateLimitWindow | null;
  if (!window) {
    return null;
  }
  const percentUsed = readFiniteNumber(window.used_percent);
  const percentRemaining = toPercentRemaining(percentUsed);
  const windowMinutes = readFiniteNumber(window.window_minutes);
  const resetAt = normalizeSessionResetAt(window.resets_at);

  if (percentUsed == null && percentRemaining == null && windowMinutes == null && resetAt == null) {
    return null;
  }

  return {
    scope: RuntimeLimitScope.TIME,
    name: formatWindowName(windowMinutes),
    unit: windowMinutes != null ? "minutes" : null,
    percentUsed,
    percentRemaining,
    resetAt,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
  };
}

function resolveSnapshotStatus(
  windows: Array<{ percentRemaining?: number | null }>,
): RuntimeLimitStatus {
  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        Number.isFinite(window.percentRemaining) &&
        window.percentRemaining <= 0,
    )
  ) {
    return RuntimeLimitStatusEnum.BLOCKED;
  }

  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        Number.isFinite(window.percentRemaining) &&
        window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
    )
  ) {
    return RuntimeLimitStatusEnum.WARNING;
  }

  if (windows.length > 0) {
    return RuntimeLimitStatusEnum.OK;
  }

  return RuntimeLimitStatusEnum.UNKNOWN;
}

function buildCodexLimitSnapshot(
  rateLimitsRaw: unknown,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    checkedAt: string;
    authIdentity?: CodexAuthIdentity | null;
  },
): RuntimeLimitSnapshot | null {
  const rateLimits = asRecord(rateLimitsRaw) as CodexSessionRateLimits | null;
  if (!rateLimits) {
    return null;
  }
  const windows = [
    buildRateLimitWindow(rateLimits.primary),
    buildRateLimitWindow(rateLimits.secondary),
  ].filter((window) => window != null);

  if (windows.length === 0) {
    return null;
  }

  const status = resolveSnapshotStatus(windows);
  const resetAt = windows
    .map((window) => window.resetAt)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const credits = asRecord(rateLimits.credits) as CodexSessionCredits | null;
  const accountFingerprint = buildCodexAuthFingerprint(input.authIdentity);

  return {
    source: RuntimeLimitSource.SDK_EVENT,
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt,
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: RuntimeLimitScope.TIME,
    resetAt: resetAt ?? null,
    retryAfterSeconds: null,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    windows,
    providerMeta: {
      limitId: readString(rateLimits.limit_id) ?? null,
      limitName: readString(rateLimits.limit_name) ?? null,
      planType: input.authIdentity?.planType ?? readString(rateLimits.plan_type) ?? null,
      accountId: input.authIdentity?.accountId ?? null,
      authMode: input.authIdentity?.authMode ?? null,
      accountName: input.authIdentity?.accountName ?? null,
      accountEmail: input.authIdentity?.accountEmail ?? null,
      accountFingerprint,
      credits: {
        hasCredits: readBoolean(credits?.has_credits),
        unlimited: readBoolean(credits?.unlimited),
        balance: readFiniteNumber(credits?.balance),
      },
    },
  };
}

function mapToRuntimeSession(
  meta: CodexSessionMeta,
  profileId: string | null | undefined,
): RuntimeSession {
  return {
    id: meta.id,
    runtimeId: "codex",
    providerId: "openai",
    profileId: profileId ?? null,
    model: meta.model ?? null,
    title: meta.prompt?.slice(0, 80) ?? null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    metadata: { raw: meta },
  };
}

async function listSessionFileInfos(dir: string): Promise<CodexSessionFileInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: CodexSessionFileInfo[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFileInfos(fullPath)));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const info = await stat(fullPath);
      const mtimeMs = readDateMs(info.mtime, Date.now());
      files.push({
        filePath: fullPath,
        birthtimeMs: readDateMs(info.birthtime, mtimeMs),
        mtimeMs,
        size: typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0,
      });
    } catch {
      // Session files can disappear while Codex rotates or cleans them up.
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files;
}

export async function listCodexSessionFileInfos(input?: {
  sessionsDir?: string;
}): Promise<CodexSessionFileInfo[]> {
  return await listSessionFileInfos(input?.sessionsDir ?? SESSIONS_DIR);
}

// Cap streamed-meta reads: session_meta/turn_context sit on the first handful
// of lines, and the first user_message typically follows within a few KB. Stop
// reading once we've found what meta consumers need — large sessions otherwise
// force megabytes of needless I/O when just rendering the sessions list.
const SESSION_META_MAX_BYTES = 64 * 1024;

async function readSessionMetaFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
): Promise<CodexSessionMeta | null> {
  let fileInfo: CodexSessionFileInfo;
  if (typeof fileInfoOrPath === "string") {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(fileInfoOrPath);
    } catch {
      return null;
    }
    const mtimeMs = readDateMs(info.mtime, Date.now());
    fileInfo = {
      filePath: fileInfoOrPath,
      birthtimeMs: readDateMs(info.birthtime, mtimeMs),
      mtimeMs,
      size: typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0,
    };
  } else {
    fileInfo = fileInfoOrPath;
  }

  const fallbackId = sessionIdFromFilePath(fileInfo.filePath);
  if (!fallbackId) return null;

  const cacheKey = `${fileInfo.filePath}|${fileInfo.mtimeMs}|${fileInfo.size}`;
  const cached = sessionMetaByFileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let resolvedId = fallbackId;
  let createdAt = new Date(fileInfo.birthtimeMs).toISOString();
  let model: string | undefined;
  let prompt: string | undefined;
  let cwd: string | undefined;

  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    stream = createReadStream(fileInfo.filePath, {
      encoding: "utf-8",
      end: SESSION_META_MAX_BYTES - 1,
    });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const entry = parseJsonLine(line);
        if (!entry) continue;

        if (readString(entry.type) === "session_meta") {
          const payload = asRecord(entry.payload);
          resolvedId = readString(payload?.id) ?? resolvedId;
          createdAt = toIso(
            (payload?.timestamp as string | number | undefined) ??
              (entry.timestamp as string | number | undefined),
          );
          cwd = readString(payload?.cwd) ?? cwd;
          model = readModelIdentifier(payload) ?? model;
          continue;
        }

        if (readString(entry.type) === "turn_context") {
          const payload = asRecord(entry.payload);
          model = readModelIdentifier(payload) ?? model;
          continue;
        }

        if (readString(entry.type) === "event_msg") {
          const payload = asRecord(entry.payload);
          if (readString(payload?.type) === "user_message") {
            prompt = readString(payload?.message) ?? prompt;
            if (prompt && model) break;
          }
        }
      }
    } finally {
      reader.close();
    }
  } catch {
    return {
      id: fallbackId,
      createdAt,
      updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
      filePath: fileInfo.filePath,
    };
  } finally {
    stream?.destroy();
  }

  const meta = {
    id: resolvedId,
    model,
    prompt,
    cwd,
    createdAt,
    updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
    filePath: fileInfo.filePath,
  };
  sessionMetaByFileCache.set(cacheKey, meta);
  return meta;
}

export async function readCodexSessionMetaFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
): Promise<CodexSessionMeta | null> {
  return await readSessionMetaFromFile(fileInfoOrPath);
}

async function readSessionMetas(): Promise<CodexSessionMeta[]> {
  const cached = sessionMetasCache.get("all");
  if (cached) {
    return cached;
  }

  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  const sessions = (
    await Promise.all(sessionFiles.map((fileInfo) => readSessionMetaFromFile(fileInfo)))
  ).filter((session): session is CodexSessionMeta => Boolean(session));

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  sessionMetasCache.set("all", sessions);
  return sessions;
}

async function readSessionMetasLazy(input: {
  projectRoot?: string | null;
  limit?: number | null;
}): Promise<CodexSessionMeta[]> {
  if (!input.projectRoot && !input.limit) {
    return await readSessionMetas();
  }

  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  const fileInfos = await listSessionFileInfos(SESSIONS_DIR);
  const sessions: CodexSessionMeta[] = [];

  for (const fileInfo of fileInfos) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (!session) {
      continue;
    }
    if (normalizedProjectRoot && normalizePath(session.cwd) !== normalizedProjectRoot) {
      continue;
    }

    sessions.push(session);
    if (input.limit && sessions.length >= input.limit) {
      break;
    }
  }

  return sessions;
}

async function findSessionFileInfoById(sessionId: string): Promise<CodexSessionFileInfo | null> {
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  const filenameMatch = sessionFiles.find(
    (fileInfo) => sessionIdFromFilePath(fileInfo.filePath) === sessionId,
  );
  if (filenameMatch) {
    return filenameMatch;
  }

  for (const fileInfo of sessionFiles) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (session?.id === sessionId) {
      return fileInfo;
    }
  }

  return null;
}

export async function findCodexSessionFileInfoById(
  sessionId: string,
): Promise<CodexSessionFileInfo | null> {
  return await findSessionFileInfoById(sessionId);
}

export function classifyCodexSessionFileStatus(input: {
  previous: CodexIndexedFileState | null;
  current: CodexSessionFileInfo | null;
  importVersion: number;
}): CodexSessionFileStatus {
  if (!input.current) {
    return "missing";
  }
  if (!input.previous) {
    return "new";
  }
  if (input.previous.importVersion !== input.importVersion) {
    return "rewrite";
  }
  if (
    input.previous.mtimeMs === input.current.mtimeMs &&
    input.previous.sizeBytes === input.current.size
  ) {
    return "unchanged";
  }
  if (
    input.current.size > input.previous.sizeBytes &&
    input.current.mtimeMs >= input.previous.mtimeMs
  ) {
    return "appended";
  }
  return "rewrite";
}

export async function listCodexSdkSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  const sessions = await readSessionMetasLazy({
    projectRoot: input.projectRoot,
    limit: input.limit ?? null,
  });
  return sessions.map((session) => mapToRuntimeSession(session, input.profileId));
}

export async function getCodexSdkSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  const session = fileInfo ? await readSessionMetaFromFile(fileInfo) : null;
  return session ? mapToRuntimeSession(session, input.profileId) : null;
}

export async function listCodexSdkSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  if (!fileInfo) return [];
  return await readSessionEventsFromFile(fileInfo, { limit: input.limit ?? undefined });
}

async function readSessionEventsFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
  input: { limit?: number } = {},
): Promise<RuntimeEvent[]> {
  const filePath = typeof fileInfoOrPath === "string" ? fileInfoOrPath : fileInfoOrPath.filePath;

  let lines: string[];
  try {
    const raw = await readFile(filePath, "utf-8");
    lines = raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }

  const events: RuntimeEvent[] = [];
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry || readString(entry.type) !== "event_msg") continue;

    const payload = asRecord(entry.payload);
    const payloadType = readString(payload?.type);
    const text = readString(payload?.message);
    if (!payloadType || !text) continue;

    if (payloadType === "agent_message") {
      const phase = readString(payload?.phase);
      if (phase && phase !== "final_answer") {
        continue;
      }
    }

    if (payloadType !== "user_message" && payloadType !== "agent_message") {
      continue;
    }

    events.push({
      type: "session-message",
      timestamp: toIso(entry.timestamp as string | number | undefined),
      level: "info",
      message: text,
      data: {
        role: payloadType === "user_message" ? "user" : "assistant",
        id: readString(payload?.turn_id) ?? readString(payload?.id),
      },
    });
  }

  return input.limit ? events.slice(-input.limit) : events;
}

export async function readCodexSessionEventsFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
  input: { limit?: number } = {},
): Promise<RuntimeEvent[]> {
  return await readSessionEventsFromFile(fileInfoOrPath, input);
}

export async function getCodexSessionLimitSnapshot(input: {
  sessionId: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const snapshots = await getCodexSessionLimitSnapshots(input);
  return snapshots[0] ?? null;
}

function normalizeModelIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isSparkCodexModel(model: string | null | undefined): boolean {
  const normalized = normalizeModelIdentifier(model);
  return normalized?.includes("spark") ?? false;
}

async function readFileRange(input: {
  filePath: string;
  start: number;
  end: number;
}): Promise<string> {
  let raw = "";
  const stream = createReadStream(input.filePath, {
    encoding: "utf-8",
    start: input.start,
    end: input.end,
  });

  try {
    for await (const chunk of stream) {
      raw += typeof chunk === "string" ? chunk : String(chunk);
    }
  } finally {
    stream.destroy();
  }

  return raw;
}

async function* readJsonlLinesNewestFirst(fileInfo: CodexSessionFileInfo): AsyncGenerator<string> {
  if (fileInfo.size <= 0) {
    const raw = await readFile(fileInfo.filePath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      yield lines[index]!;
    }
    return;
  }

  let position = fileInfo.size;
  let leadingPartial = "";

  while (position > 0) {
    const start = Math.max(0, position - LIMIT_SNAPSHOT_TAIL_CHUNK_BYTES);
    const end = position - 1;
    const chunk = await readFileRange({ filePath: fileInfo.filePath, start, end });
    position = start;

    const parts = `${chunk}${leadingPartial}`.split(/\r?\n/);
    leadingPartial = parts.shift() ?? "";
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      yield parts[index]!;
    }
  }

  if (leadingPartial) {
    yield leadingPartial;
  }
}

function splitAppendedJsonlLines(raw: string): {
  lines: string[];
  pendingTail: string;
} {
  const lines = raw.split(/\r?\n/);
  const pendingTail = lines.pop() ?? "";
  return { lines, pendingTail };
}

function collectCodexLimitSnapshotsFromLines(
  lines: Iterable<string>,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    authIdentity?: CodexAuthIdentity | null;
    keepLatestPerLimit: boolean;
  },
): RuntimeLimitSnapshot[] {
  const snapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;

  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry || readString(entry.type) !== "event_msg") continue;

    const payload = asRecord(entry.payload);
    if (!payload) continue;
    if (readString(payload.type) !== "token_count") continue;

    const snapshot = buildCodexLimitSnapshot(payload.rate_limits, {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      checkedAt: toIso(entry.timestamp as string | number | undefined),
      authIdentity: input.authIdentity,
    });
    if (!snapshot) {
      continue;
    }

    const limitId = readSnapshotLimitId(snapshot);
    if (!limitId) {
      latestUnknownSnapshot = input.keepLatestPerLimit
        ? snapshot
        : (latestUnknownSnapshot ?? snapshot);
    } else if (input.keepLatestPerLimit || !snapshotsByLimitId.has(limitId)) {
      snapshotsByLimitId.set(limitId, snapshot);
    }
  }

  const snapshots = [...snapshotsByLimitId.values()];
  if (latestUnknownSnapshot) {
    snapshots.push(latestUnknownSnapshot);
  }
  snapshots.sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  return snapshots;
}

export async function readCodexSessionLimitSnapshotsFromAppend(input: {
  fileInfo: CodexSessionFileInfo;
  startOffset: number;
  pendingTail?: string | null;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  authIdentity?: CodexAuthIdentity | null;
}): Promise<CodexAppendLimitSnapshotsResult> {
  const previousTail = input.pendingTail ?? "";
  const startOffset =
    typeof input.startOffset === "number" && Number.isFinite(input.startOffset)
      ? Math.max(0, Math.trunc(input.startOffset))
      : 0;
  if (input.fileInfo.size <= startOffset) {
    return {
      snapshots: [],
      parsedOffset: input.fileInfo.size,
      pendingTail: previousTail,
    };
  }

  try {
    const appended = await readFileRange({
      filePath: input.fileInfo.filePath,
      start: startOffset,
      end: input.fileInfo.size - 1,
    });
    const { lines, pendingTail } = splitAppendedJsonlLines(`${previousTail}${appended}`);
    const authIdentity = input.authIdentity ?? (await getCodexAuthIdentity());
    return {
      snapshots: collectCodexLimitSnapshotsFromLines(lines, {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        authIdentity,
        keepLatestPerLimit: true,
      }),
      parsedOffset: input.fileInfo.size,
      pendingTail,
    };
  } catch {
    return {
      snapshots: [],
      parsedOffset: startOffset,
      pendingTail: previousTail,
    };
  }
}

export async function readCodexSessionLimitSnapshotsFromFile(
  fileInfo: CodexSessionFileInfo,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    authIdentity?: CodexAuthIdentity | null;
    fast?: boolean;
  },
): Promise<RuntimeLimitSnapshot[]> {
  const mode = input.fast ? "fast" : "complete";
  const cacheKey = `${mode}|${fileInfo.filePath}|${fileInfo.mtimeMs}|${fileInfo.size}|${input.runtimeId}|${input.providerId}`;
  const cached = sessionLimitSnapshotsCache.get(cacheKey);
  if (cached) {
    return cached.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
  }

  const authIdentity = input.authIdentity ?? (await getCodexAuthIdentity());
  const lines: string[] = [];

  try {
    for await (const line of readJsonlLinesNewestFirst(fileInfo)) {
      lines.push(line);

      const entry = parseJsonLine(line);
      const payload =
        entry && readString(entry.type) === "event_msg" ? asRecord(entry.payload) : null;
      const snapshot =
        payload && readString(payload.type) === "token_count"
          ? buildCodexLimitSnapshot(payload.rate_limits, {
              runtimeId: input.runtimeId,
              providerId: input.providerId,
              profileId: input.profileId ?? null,
              checkedAt: toIso(entry?.timestamp as string | number | undefined),
              authIdentity,
            })
          : null;
      if (input.fast && snapshot) {
        break;
      }
    }
  } catch {
    return [];
  }

  const snapshots = collectCodexLimitSnapshotsFromLines(lines, {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId ?? null,
    authIdentity,
    keepLatestPerLimit: false,
  });
  const normalizedSnapshots = snapshots.map((snapshot) => ({ ...snapshot, profileId: null }));
  sessionLimitSnapshotsCache.set(cacheKey, normalizedSnapshots);
  return normalizedSnapshots.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
}

export async function readLatestCodexSessionLimitSnapshotFromFile(input: {
  fileInfo: CodexSessionFileInfo;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  authIdentity?: CodexAuthIdentity | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const snapshots = await readCodexSessionLimitSnapshotsFromFile(input.fileInfo, {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId ?? null,
    authIdentity: input.authIdentity ?? null,
    fast: true,
  });
  return snapshots[0] ?? null;
}

async function getCodexSessionLimitSnapshots(input: {
  sessionId: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  if (!fileInfo) {
    return [];
  }

  return await readCodexSessionLimitSnapshotsFromFile(fileInfo, input);
}

export async function listLatestCodexLimitSnapshots(input: {
  runtimeId: string;
  providerId: string;
  projectRoot?: string | null;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  // Result-level cache: the underlying scan walks up to N session files every
  // call; holding the aggregated result keeps repeated API polls off the disk.
  // Cache key intentionally excludes profileId so concurrent profiles share it;
  // profileId is reapplied below via applySnapshotProfileId.
  const cacheKey = `${input.runtimeId}|${input.providerId}|${normalizedProjectRoot ?? "__global__"}`;
  const cached = latestLimitSnapshotsCache.get(cacheKey);
  if (cached) {
    return cached.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
  }
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  const candidates: CodexSessionFileInfo[] = [];
  for (const fileInfo of sessionFiles) {
    if (normalizedProjectRoot) {
      const session = await readSessionMetaFromFile(fileInfo);
      if (!session || normalizePath(session.cwd) !== normalizedProjectRoot) {
        continue;
      }
    }
    candidates.push(fileInfo);
    if (candidates.length >= LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT) {
      break;
    }
  }
  // Rate limits are point-in-time data in recent token_count events, so scan
  // only the newest matching files instead of hydrating all session metadata.
  const latestSnapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;
  const authIdentity = await getCodexAuthIdentity();

  for (const fileInfo of candidates) {
    const snapshots = await readCodexSessionLimitSnapshotsFromFile(fileInfo, {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      authIdentity,
      fast: true,
    });
    for (const snapshot of snapshots) {
      const limitId = readSnapshotLimitId(snapshot);
      if (!limitId) {
        latestUnknownSnapshot ??= snapshot;
        continue;
      }
      if (!latestSnapshotsByLimitId.has(limitId)) {
        latestSnapshotsByLimitId.set(limitId, snapshot);
      }
    }
  }

  const latestSnapshots = [...latestSnapshotsByLimitId.values()];
  if (latestUnknownSnapshot) {
    latestSnapshots.push(latestUnknownSnapshot);
  }
  latestSnapshots.sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  const normalizedSnapshots = latestSnapshots.map((snapshot) => ({ ...snapshot, profileId: null }));
  latestLimitSnapshotsCache.set(cacheKey, normalizedSnapshots);
  return normalizedSnapshots.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
}

export function selectPreferredCodexLimitSnapshot(input: {
  model?: string | null;
  snapshots: RuntimeLimitSnapshot[];
  preferredLimitId?: string | null;
}): RuntimeLimitSnapshot | null {
  if (input.snapshots.length === 0) {
    return null;
  }

  const orderedSnapshots = [...input.snapshots].sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  const explicitSnapshots = orderedSnapshots.filter(
    (snapshot) => readSnapshotLimitId(snapshot) != null,
  );
  const preferredLimitId = input.preferredLimitId?.trim() || null;
  const defaultSnapshot =
    explicitSnapshots.find(
      (snapshot) => readSnapshotLimitId(snapshot) === DEFAULT_CODEX_LIMIT_ID,
    ) ?? null;
  const preferredSnapshot =
    explicitSnapshots.find((snapshot) => readSnapshotLimitId(snapshot) === preferredLimitId) ??
    null;
  const alternateSnapshot =
    explicitSnapshots.find(
      (snapshot) => readSnapshotLimitId(snapshot) !== DEFAULT_CODEX_LIMIT_ID,
    ) ?? null;

  if (isSparkCodexModel(input.model)) {
    return alternateSnapshot ?? preferredSnapshot ?? defaultSnapshot ?? orderedSnapshots[0] ?? null;
  }

  return (
    defaultSnapshot ?? preferredSnapshot ?? explicitSnapshots[0] ?? orderedSnapshots[0] ?? null
  );
}

export async function getLatestCodexModelLimitSnapshot(input: {
  runtimeId: string;
  providerId: string;
  model?: string | null;
  projectRoot?: string | null;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const targetModel = normalizeModelIdentifier(input.model ?? null);
  if (!targetModel) {
    return null;
  }

  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);

  for (const fileInfo of sessionFiles) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (!session) {
      continue;
    }
    if (normalizedProjectRoot && normalizePath(session.cwd) !== normalizedProjectRoot) {
      continue;
    }
    if (normalizeModelIdentifier(session.model ?? null) !== targetModel) {
      continue;
    }

    const snapshot = (
      await readCodexSessionLimitSnapshotsFromFile(fileInfo, {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        fast: true,
      })
    )[0];
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}
