import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface CodexSessionMeta {
  id: string;
  model?: string;
  prompt?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
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
const SESSION_CACHE_TTL_MS = 5_000;

const sessionMetasCache = createRuntimeMemoryCache<CodexSessionMeta[]>({
  defaultTtlMs: SESSION_CACHE_TTL_MS,
  maxSize: 1,
});
const sessionLimitSnapshotsCache = createRuntimeMemoryCache<RuntimeLimitSnapshot[]>({
  defaultTtlMs: SESSION_CACHE_TTL_MS,
  maxSize: 512,
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

function sessionIdFromFilePath(filePath: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(filePath);
  return match?.[1] ?? null;
}

function normalizePath(value: string | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
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
  const window = asRecord(rawWindow) as CodexSessionRateLimitWindow;
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
  const rateLimits = asRecord(rateLimitsRaw) as CodexSessionRateLimits;
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

async function listSessionFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readSessionMetaFromFile(filePath: string): Promise<CodexSessionMeta | null> {
  const fallbackId = sessionIdFromFilePath(filePath);
  if (!fallbackId) return null;

  const info = await stat(filePath);
  let raw = "";
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return {
      id: fallbackId,
      createdAt: info.birthtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
      filePath,
    };
  }

  let resolvedId = fallbackId;
  let createdAt = info.birthtime.toISOString();
  let model: string | undefined;
  let prompt: string | undefined;
  let cwd: string | undefined;

  for (const line of raw.split("\n")) {
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

  return {
    id: resolvedId,
    model,
    prompt,
    cwd,
    createdAt,
    updatedAt: info.mtime.toISOString(),
    filePath,
  };
}

async function readSessionMetas(): Promise<CodexSessionMeta[]> {
  const cached = sessionMetasCache.get("all");
  if (cached) {
    return cached;
  }

  const sessionFiles = await listSessionFiles(SESSIONS_DIR);
  const sessions = (
    await Promise.all(sessionFiles.map((filePath) => readSessionMetaFromFile(filePath)))
  ).filter((session): session is CodexSessionMeta => Boolean(session));

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  sessionMetasCache.set("all", sessions);
  return sessions;
}

export async function listCodexSdkSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  const sessions = await readSessionMetas();
  const projectRoot = normalizePath(input.projectRoot);
  const filteredSessions = projectRoot
    ? sessions.filter((session) => normalizePath(session.cwd) === projectRoot)
    : sessions;
  const mapped = filteredSessions.map((session) => mapToRuntimeSession(session, input.profileId));
  return input.limit ? mapped.slice(0, input.limit) : mapped;
}

export async function getCodexSdkSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  const session = (await readSessionMetas()).find((meta) => meta.id === input.sessionId);
  return session ? mapToRuntimeSession(session, input.profileId) : null;
}

export async function listCodexSdkSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  const session = (await readSessionMetas()).find((meta) => meta.id === input.sessionId);
  if (!session?.filePath) {
    return [];
  }

  let lines: string[];
  try {
    const raw = await readFile(session.filePath, "utf-8");
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

async function getCodexSessionLimitSnapshots(input: {
  sessionId: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const session = (await readSessionMetas()).find((meta) => meta.id === input.sessionId);
  if (!session?.filePath) {
    return [];
  }

  const cacheKey = `${session.filePath}|${session.updatedAt}|${input.runtimeId}|${input.providerId}`;
  const cached = sessionLimitSnapshotsCache.get(cacheKey);
  if (cached) {
    return cached.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
  }

  let lines: string[];
  try {
    const raw = await readFile(session.filePath, "utf-8");
    lines = raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }

  const authIdentity = await getCodexAuthIdentity();
  const snapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJsonLine(lines[index]!);
    if (!entry || readString(entry.type) !== "event_msg") continue;

    const payload = asRecord(entry.payload);
    if (!payload) continue;
    if (readString(payload.type) !== "token_count") continue;

    const snapshot = buildCodexLimitSnapshot(payload.rate_limits, {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      checkedAt: toIso(entry.timestamp as string | number | undefined),
      authIdentity,
    });
    if (!snapshot) {
      continue;
    }

    const limitId = readSnapshotLimitId(snapshot);
    if (!limitId) {
      latestUnknownSnapshot ??= snapshot;
      continue;
    }
    if (!snapshotsByLimitId.has(limitId)) {
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
  const normalizedSnapshots = snapshots.map((snapshot) => ({ ...snapshot, profileId: null }));
  sessionLimitSnapshotsCache.set(cacheKey, normalizedSnapshots);
  return normalizedSnapshots.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
}

export async function listLatestCodexLimitSnapshots(input: {
  runtimeId: string;
  providerId: string;
  projectRoot?: string | null;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  const sessions = await readSessionMetas();
  const candidates = normalizedProjectRoot
    ? sessions.filter((session) => normalizePath(session.cwd) === normalizedProjectRoot)
    : sessions;

  const latestSnapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;

  for (const session of candidates) {
    const snapshots = await getCodexSessionLimitSnapshots({
      sessionId: session.id,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
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
  return latestSnapshots;
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
  const sessions = await readSessionMetas();
  const candidates = sessions.filter((session) => {
    if (normalizedProjectRoot && normalizePath(session.cwd) !== normalizedProjectRoot) {
      return false;
    }
    return normalizeModelIdentifier(session.model ?? null) === targetModel;
  });

  for (const session of candidates) {
    const snapshot = await getCodexSessionLimitSnapshot({
      sessionId: session.id,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
    });
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}
