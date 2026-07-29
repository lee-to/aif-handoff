import {
  RuntimeTransport,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
} from "../../../types.js";
import { CodexAppServerClient } from "./client.js";
import { JsonlRpcClient } from "./jsonlRpcClient.js";
import { spawnCodexAppServerProcess, terminateCodexAppServerProcess } from "./process.js";
import type { Thread } from "./generated/v2/Thread.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { UserInput } from "./generated/v2/UserInput.js";

export interface CodexAppServerSessionLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

const DEFAULT_SESSION_REQUEST_TIMEOUT_MS = 8_000;
const SESSION_LIST_CACHE_TTL_MS = 1_000;
const SESSION_LIST_CACHE_MAX_ENTRIES = 32;

interface SessionListCacheEntry {
  expiresAt: number;
  sessions: RuntimeSession[];
}

const sessionListCache = new Map<string, SessionListCacheEntry>();

export async function listCodexAppServerSessions(
  input: RuntimeSessionListInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeSession[]> {
  const cacheKey = buildSessionListCacheKey(input);
  const cached = readSessionListCache(cacheKey);
  if (cached) {
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: RuntimeTransport.APP_SERVER,
      },
      "DEBUG [runtime:codex] Reusing cached Codex app-server session discovery result",
    );
    return cached;
  }

  const sessions = await withAppServerSessionClient(input, logger, async (client) => {
    const result = await client.listThreads({
      limit: input.limit ?? 50,
      cursor: null,
      cwd: input.projectRoot ?? null,
      archived: false,
      sortKey: "updated_at",
      sourceKinds: null,
      modelProviders: null,
      searchTerm: null,
    });

    return result.data.map((thread) => mapThreadToRuntimeSession(thread, input));
  });
  writeSessionListCache(cacheKey, sessions);
  return cloneSessions(sessions);
}

export async function getCodexAppServerSession(
  input: RuntimeSessionGetInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeSession | null> {
  return await withAppServerSessionClient(input, logger, async (client) => {
    const result = await client.readThread({
      threadId: input.sessionId,
      includeTurns: false,
    });
    return mapThreadToRuntimeSession(result.thread, input);
  });
}

export async function listCodexAppServerSessionEvents(
  input: RuntimeSessionEventsInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeEvent[]> {
  return await withAppServerSessionClient(input, logger, async (client) => {
    const result = await client.readThread({
      threadId: input.sessionId,
      includeTurns: true,
    });
    const events = threadToRuntimeEvents(result.thread);
    return input.limit ? events.slice(-input.limit) : events;
  });
}

async function withAppServerSessionClient<T>(
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
  logger: CodexAppServerSessionLogger | undefined,
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const requestTimeoutMs = resolveSessionRequestTimeout(input);
  const launch = spawnCodexAppServerProcess({
    input: {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: RuntimeTransport.APP_SERVER,
      projectRoot: input.projectRoot,
      options: input.options ?? {},
    },
    logger,
  });
  const rpcClient = new JsonlRpcClient(launch.process, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs,
    logger,
  });
  const client = new CodexAppServerClient(rpcClient, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs,
    logger,
  });

  try {
    await client.initialize({
      clientInfo: {
        name: "aif-runtime-codex-session-discovery",
        title: "AIF Runtime Codex Session Discovery",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    return await run(client);
  } finally {
    client.close("session discovery finished");
    await terminateCodexAppServerProcess(launch, logger);
  }
}

function resolveSessionRequestTimeout(
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
): number {
  const optionTimeout = readNumber(asRecord(input.options)?.appServerRequestTimeoutMs);
  return optionTimeout && optionTimeout > 0
    ? Math.floor(optionTimeout)
    : DEFAULT_SESSION_REQUEST_TIMEOUT_MS;
}

function readSessionListCache(cacheKey: string): RuntimeSession[] | null {
  const entry = sessionListCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    sessionListCache.delete(cacheKey);
    return null;
  }
  return cloneSessions(entry.sessions);
}

function writeSessionListCache(cacheKey: string, sessions: RuntimeSession[]): void {
  if (sessionListCache.size >= SESSION_LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = sessionListCache.keys().next().value;
    if (oldestKey) {
      sessionListCache.delete(oldestKey);
    }
  }
  sessionListCache.set(cacheKey, {
    expiresAt: Date.now() + SESSION_LIST_CACHE_TTL_MS,
    sessions: cloneSessions(sessions),
  });
}

function cloneSessions(sessions: RuntimeSession[]): RuntimeSession[] {
  return sessions.map((session) => ({
    ...session,
    metadata: session.metadata ? { ...session.metadata } : undefined,
  }));
}

function buildSessionListCacheKey(input: RuntimeSessionListInput): string {
  return stableStringify({
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? null,
    profileId: input.profileId ?? null,
    projectRoot: input.projectRoot ?? null,
    transport: input.transport ?? RuntimeTransport.APP_SERVER,
    limit: input.limit ?? 50,
    options: asRecord(input.options) ?? {},
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mapThreadToRuntimeSession(
  thread: Thread,
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
): RuntimeSession {
  return {
    id: thread.id,
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? thread.modelProvider ?? "openai",
    profileId: input.profileId ?? null,
    title: thread.name ?? truncateTitle(thread.preview) ?? null,
    createdAt: toIsoFromSeconds(thread.createdAt),
    updatedAt: toIsoFromSeconds(thread.updatedAt),
    metadata: {
      cwd: thread.cwd,
      source: thread.source,
      status: thread.status,
      raw: thread,
    },
  };
}

function threadToRuntimeEvents(thread: Thread): RuntimeEvent[] {
  const timestamp = toIsoFromSeconds(thread.updatedAt);
  const events: RuntimeEvent[] = [];

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const event = threadItemToRuntimeEvent(item, timestamp);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

function threadItemToRuntimeEvent(item: ThreadItem, timestamp: string): RuntimeEvent | null {
  if (item.type === "userMessage") {
    const message = renderUserInput(item.content);
    if (!message) {
      return null;
    }
    return {
      type: "session-message",
      timestamp,
      level: "info",
      message,
      data: {
        role: "user",
        id: item.id,
      },
    };
  }

  if (item.type === "agentMessage") {
    if (item.phase && item.phase !== "final_answer") {
      return null;
    }
    if (!item.text.trim()) {
      return null;
    }
    return {
      type: "session-message",
      timestamp,
      level: "info",
      message: item.text,
      data: {
        role: "assistant",
        id: item.id,
      },
    };
  }

  return null;
}

function renderUserInput(content: UserInput[]): string {
  return content
    .map((entry) => {
      switch (entry.type) {
        case "text":
          return entry.text;
        case "image":
          return `[image: ${entry.url}]`;
        case "localImage":
          return `[image: ${entry.path}]`;
        case "skill":
          return `[$${entry.name}](${entry.path})`;
        case "mention":
          return `[@${entry.name}](${entry.path})`;
        default:
          return "";
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
}

function toIsoFromSeconds(value: number): string {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function truncateTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
