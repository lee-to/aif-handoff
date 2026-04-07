import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";

/**
 * Codex SDK persists threads in ~/.codex/sessions/.
 * Each session is a directory containing a JSONL conversation file.
 * This module reads persisted session metadata for the RuntimeAdapter session API.
 */

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

interface CodexSessionMeta {
  id: string;
  model?: string;
  prompt?: string;
  createdAt: string;
  updatedAt: string;
}

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

async function readSessionDirs(): Promise<CodexSessionMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const sessions: CodexSessionMeta[] = [];
  for (const entry of entries) {
    const sessionDir = join(SESSIONS_DIR, entry);
    try {
      const info = await stat(sessionDir);
      if (!info.isDirectory()) continue;

      // Try reading session metadata from a meta.json or infer from directory
      const metaPath = join(sessionDir, "meta.json");
      let meta: CodexSessionMeta;
      try {
        const raw = await readFile(metaPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        meta = {
          id: entry,
          model: typeof parsed.model === "string" ? parsed.model : undefined,
          prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
          createdAt: toIso(parsed.createdAt as string | number | undefined),
          updatedAt: toIso(parsed.updatedAt as string | number | undefined),
        };
      } catch {
        // No meta.json — fall back to directory timestamps
        meta = {
          id: entry,
          createdAt: info.birthtime.toISOString(),
          updatedAt: info.mtime.toISOString(),
        };
      }
      sessions.push(meta);
    } catch {
      // Skip unreadable entries
    }
  }

  // Sort by updatedAt descending (most recent first)
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

export async function listCodexSdkSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  const sessions = await readSessionDirs();
  const mapped = sessions.map((s) => mapToRuntimeSession(s, input.profileId));
  return input.limit ? mapped.slice(0, input.limit) : mapped;
}

export async function getCodexSdkSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  const sessionDir = join(SESSIONS_DIR, input.sessionId);
  try {
    const info = await stat(sessionDir);
    if (!info.isDirectory()) return null;

    const metaPath = join(sessionDir, "meta.json");
    let meta: CodexSessionMeta;
    try {
      const raw = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      meta = {
        id: input.sessionId,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
        createdAt: toIso(parsed.createdAt as string | number | undefined),
        updatedAt: toIso(parsed.updatedAt as string | number | undefined),
      };
    } catch {
      meta = {
        id: input.sessionId,
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
      };
    }
    return mapToRuntimeSession(meta, input.profileId);
  } catch {
    return null;
  }
}

export async function listCodexSdkSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  const sessionDir = join(SESSIONS_DIR, input.sessionId);

  // Try reading the JSONL conversation log
  const conversationPath = join(sessionDir, "conversation.jsonl");
  let lines: string[];
  try {
    const raw = await readFile(conversationPath, "utf-8");
    lines = raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }

  const events: RuntimeEvent[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = typeof entry.type === "string" ? entry.type : "unknown";
      const text =
        typeof entry.text === "string"
          ? entry.text
          : typeof entry.message === "string"
            ? entry.message
            : "";

      if (!text) continue;

      events.push({
        type: "session-message",
        timestamp: toIso(entry.timestamp as string | number | undefined),
        level: "info",
        message: text,
        data: {
          role: type.includes("user") ? "user" : "assistant",
          id: typeof entry.id === "string" ? entry.id : undefined,
        },
      });
    } catch {
      // Skip malformed lines
    }
  }

  return input.limit ? events.slice(-input.limit) : events;
}
