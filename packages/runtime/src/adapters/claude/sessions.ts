import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import { toolQuestionEvent } from "../../toolEvents.js";
import { classifyClaudeRuntimeError } from "./errors.js";
import { parseClaudeAskUserQuestion } from "./questions.js";

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
  try {
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    // fall through to default
  }
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

function extractAssistantToolQuestionEvents(
  message: ClaudeSessionMessage,
  timestamp: string,
): RuntimeEvent[] {
  const raw = message.message;
  if (!raw || typeof raw !== "object") return [];
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const events: RuntimeEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; name?: string; id?: string; input?: unknown };
    if (item.type !== "tool_use" || typeof item.name !== "string") continue;
    const toolUseId = typeof item.id === "string" ? item.id : null;
    const payload = parseClaudeAskUserQuestion(item.name, toolUseId, item.input);
    if (!payload) continue;
    events.push(toolQuestionEvent(payload, timestamp));
  }
  return events;
}

export async function listClaudeRuntimeSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  try {
    const messages = (await getSessionMessages(input.sessionId)) as ClaudeSessionMessage[];
    const events: RuntimeEvent[] = [];

    for (const message of messages) {
      if (message.type !== "user" && message.type !== "assistant") continue;
      const timestamp = toIso(message.createdAt);
      const text = extractTextContent(message.message);

      if (text.length > 0) {
        events.push({
          type: "session-message",
          timestamp,
          level: "info",
          message: text,
          data: {
            role: message.type,
            id: message.uuid,
          },
        });
      }

      // Assistant turns may contain an AskUserQuestion tool_use block. Without
      // projecting these as tool:question events, virtual/runtime-only session
      // replay (GET /chat/sessions/:id/messages for sdk:/runtime: ids) would
      // drop the question entirely when the turn carried no text alongside it.
      if (message.type === "assistant") {
        events.push(...extractAssistantToolQuestionEvents(message, timestamp));
      }
    }

    return input.limit ? events.slice(-input.limit) : events;
  } catch (error) {
    throw classifyClaudeRuntimeError(error);
  }
}
