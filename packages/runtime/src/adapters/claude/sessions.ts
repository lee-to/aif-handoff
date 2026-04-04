import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import { classifyClaudeRuntimeError } from "./errors.js";

interface ClaudeSessionSummary {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  createdAt?: string | number;
  lastModified: string | number;
  [key: string]: unknown;
}

interface ClaudeSessionMessage {
  uuid: string;
  type: string;
  message: unknown;
  createdAt?: string | number;
  [key: string]: unknown;
}

function toIso(value: string | number | undefined): string {
  if (typeof value === "string") return new Date(value).toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date().toISOString();
}

function mapClaudeSession(
  session: ClaudeSessionSummary,
  profileId: string | null | undefined,
): RuntimeSession {
  return {
    id: session.sessionId,
    runtimeId: "claude",
    providerId: "anthropic",
    profileId: profileId ?? null,
    model: null,
    title: session.customTitle || session.summary || session.firstPrompt?.slice(0, 80) || null,
    createdAt: toIso(session.createdAt ?? session.lastModified),
    updatedAt: toIso(session.lastModified),
    metadata: {
      raw: session,
    },
  };
}

function extractTextContent(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;

  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) return "";

  const parts: string[] = [];
  for (const item of record.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

export async function listClaudeRuntimeSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  if (!input.projectRoot) {
    return [];
  }

  try {
    const sessions = (await listSessions({ dir: input.projectRoot })) as ClaudeSessionSummary[];
    const mapped = sessions.map((session) => mapClaudeSession(session, input.profileId));
    return input.limit ? mapped.slice(0, input.limit) : mapped;
  } catch (error) {
    throw classifyClaudeRuntimeError(error);
  }
}

export async function getClaudeRuntimeSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  try {
    const info = (await getSessionInfo(input.sessionId)) as ClaudeSessionSummary | null;
    if (!info) return null;
    return mapClaudeSession(info, input.profileId);
  } catch (error) {
    throw classifyClaudeRuntimeError(error);
  }
}

export async function listClaudeRuntimeSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  try {
    const messages = (await getSessionMessages(input.sessionId)) as ClaudeSessionMessage[];
    const events = messages
      .filter((message) => message.type === "user" || message.type === "assistant")
      .map((message) => ({
        type: "session-message",
        timestamp: toIso(message.createdAt),
        level: "info" as const,
        message: extractTextContent(message.message),
        data: {
          role: message.type,
          id: message.uuid,
        },
      }))
      .filter((event) => event.message && event.message.length > 0);

    return input.limit ? events.slice(-input.limit) : events;
  } catch (error) {
    throw classifyClaudeRuntimeError(error);
  }
}
