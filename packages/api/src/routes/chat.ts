import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  query,
  listSessions,
  getSessionMessages,
  getSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { logger, getEnv, findClaudePath } from "@aif/shared";

const CLAUDE_PATH = findClaudePath();
import type { ChatSession, ChatSessionMessage } from "@aif/shared";
import { findProjectById } from "../repositories/projects.js";
import { findTaskById, toTaskResponse } from "../repositories/tasks.js";
import {
  createChatSession,
  findChatSessionById,
  listChatSessions,
  updateChatSession,
  deleteChatSession,
  createChatMessage,
  listChatMessages,
  updateChatSessionTimestamp,
  toChatSessionResponse,
  toChatMessageResponse,
} from "@aif/data";
import { chatRequestSchema, createChatSessionSchema, updateChatSessionSchema } from "../schemas.js";
import { broadcast, sendToClient } from "../ws.js";
import type { WsEvent, Task } from "@aif/shared";

const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

const CHAT_ACTIONS_PROMPT = `
Identity: You are AIFer.

You have special capabilities in this chat:

1. CREATE TASK: When the user asks to create a task (based on conversation, from scratch, etc.), output a structured block:
<!--ACTION:CREATE_TASK-->
{"title": "Short task title", "description": "Detailed task description with context from the conversation"}
<!--/ACTION-->
Include this block in your response along with a brief explanation of the task you're creating. The user will see a confirmation card and can approve it.

2. TASK SUMMARY: When the user asks to summarize what was done on the current task (or any task you have context for), generate a concise summary covering: what was planned, what was implemented, review results, and current status.
`.trim();

function buildContextAppend(projectName: string, task: Task | null): string {
  const parts = [PROJECT_SCOPE_SYSTEM_APPEND];

  parts.push(`\nCurrent project: "${projectName}"`);

  if (task) {
    const lines = [
      `\nCurrently open task [${task.id}]:`,
      `  Title: ${task.title}`,
      `  Status: ${task.status}`,
    ];
    if (task.description) lines.push(`  Description: ${task.description}`);
    if (task.plan) lines.push(`  Plan:\n${task.plan}`);
    if (task.implementationLog) lines.push(`  Implementation log:\n${task.implementationLog}`);
    if (task.reviewComments) lines.push(`  Review comments:\n${task.reviewComments}`);
    if (task.agentActivityLog) lines.push(`  Agent activity log:\n${task.agentActivityLog}`);
    parts.push(lines.join("\n"));
  } else {
    parts.push("No task is currently open.");
  }

  parts.push(`\n${CHAT_ACTIONS_PROMPT}`);
  return parts.join("\n");
}

const log = logger("chat-route");

function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Claude Code returned an error result:\s*/i, "").trim();
}

function classifyChatError(err: unknown): {
  status: 429 | 500;
  code: string;
  message: string;
} {
  const message = extractErrorMessage(err);
  const lowered = message.toLowerCase();

  if (
    lowered.includes("out of extra usage") ||
    lowered.includes("usage limit") ||
    lowered.includes("rate limit")
  ) {
    return {
      status: 429,
      code: "CHAT_USAGE_LIMIT",
      message,
    };
  }

  return {
    status: 500,
    code: "CHAT_REQUEST_FAILED",
    message: "Chat request failed",
  };
}

/**
 * Strip Claude Code internal XML tags from user messages (command-name, command-message, etc.)
 */
function stripCommandTags(text: string): string {
  return text
    .replace(/<command-name>[^<]*<\/command-name>/g, "")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<command-args>([^<]*)<\/command-args>/g, "$1")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
    .trim();
}

/**
 * Extract human-readable text from an SDK SessionMessage.message field.
 * Returns only user-visible text — skips thinking, tool_use, tool_result blocks.
 */
function extractMessageContent(message: unknown): string {
  if (typeof message === "string") return stripCommandTags(message);
  if (!message || typeof message !== "object") return "";

  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return stripCommandTags(msg.content);

  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (!b || typeof b !== "object") continue;

      if (b.type === "text" && typeof b.text === "string") {
        parts.push(stripCommandTags(b.text));
      }
      // Skip thinking, tool_use, tool_result — intermediate turns, not user-visible
    }
    return parts.join("\n\n").trim();
  }

  return "";
}

export const chatRouter = new Hono();

// ── Session CRUD ───────────────────────────────────────────

// GET /chat/sessions?projectId=...
chatRouter.get("/sessions", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }
  log.debug("GET /chat/sessions projectId=%s", projectId);

  // DB-backed web sessions
  const dbRows = listChatSessions(projectId);
  const dbSessions = dbRows.map(toChatSessionResponse);

  // Collect agentSessionIds that are already linked to DB sessions (avoid duplicates)
  const linkedAgentSessionIds = new Set(
    dbRows.map((r) => r.agentSessionId).filter(Boolean) as string[],
  );

  // SDK sessions (CLI + agent) — scoped to project directory
  let sdkSessions: ChatSession[] = [];
  try {
    const project = findProjectById(projectId);
    if (project) {
      const sdkList = await listSessions({ dir: project.rootPath });
      log.debug(
        "SDK listSessions returned %d sessions for dir=%s",
        sdkList.length,
        project.rootPath,
      );

      sdkSessions = sdkList
        .filter((s) => !linkedAgentSessionIds.has(s.sessionId))
        .map((s) => ({
          id: `sdk:${s.sessionId}`,
          projectId,
          title: s.customTitle || s.summary || s.firstPrompt?.slice(0, 80) || "Untitled",
          agentSessionId: s.sessionId,
          source: "cli" as const,
          createdAt: s.createdAt
            ? new Date(s.createdAt).toISOString()
            : new Date(s.lastModified).toISOString(),
          updatedAt: new Date(s.lastModified).toISOString(),
        }));
    }
  } catch (err) {
    log.warn({ err }, "Failed to list SDK sessions, returning DB sessions only");
  }

  // Merge and sort by updatedAt DESC
  const all = [...dbSessions, ...sdkSessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return c.json(all);
});

// POST /chat/sessions
chatRouter.post("/sessions", zValidator("json", createChatSessionSchema as any), async (c) => {
  const body = c.req.valid("json");
  log.debug("POST /chat/sessions projectId=%s title=%s", body.projectId, body.title);
  const row = createChatSession({ projectId: body.projectId, title: body.title });
  if (!row) {
    return c.json({ error: "Failed to create chat session" }, 500);
  }
  const session = toChatSessionResponse(row);
  broadcast({ type: "chat:session_created", payload: session });
  return c.json(session, 201);
});

// GET /chat/sessions/:id
chatRouter.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s", id);

  // Handle SDK session IDs (prefixed with "sdk:")
  if (id.startsWith("sdk:")) {
    const sdkSessionId = id.slice(4);
    try {
      const info = await getSessionInfo(sdkSessionId);
      if (!info) {
        return c.json({ error: "Chat session not found" }, 404);
      }
      const session: ChatSession = {
        id,
        projectId: "",
        title: info.customTitle || info.summary || info.firstPrompt?.slice(0, 80) || "Untitled",
        agentSessionId: info.sessionId,
        source: "cli",
        createdAt: info.createdAt
          ? new Date(info.createdAt).toISOString()
          : new Date(info.lastModified).toISOString(),
        updatedAt: new Date(info.lastModified).toISOString(),
      };
      return c.json(session);
    } catch (err) {
      log.warn({ err, sdkSessionId }, "Failed to get SDK session info");
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const row = findChatSessionById(id);
  if (!row) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  return c.json(toChatSessionResponse(row));
});

// GET /chat/sessions/:id/messages
chatRouter.get("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s/messages", id);

  // Handle SDK session messages
  if (id.startsWith("sdk:")) {
    const sdkSessionId = id.slice(4);
    try {
      const sdkMessages = await getSessionMessages(sdkSessionId);
      log.debug(
        "SDK getSessionMessages returned %d messages for session=%s",
        sdkMessages.length,
        sdkSessionId,
      );
      const messages: ChatSessionMessage[] = sdkMessages
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => ({
          id: m.uuid,
          sessionId: id,
          role: m.type as "user" | "assistant",
          content: extractMessageContent(m.message),
          createdAt: new Date().toISOString(),
        }))
        .filter((m) => m.content.trim() !== "");
      return c.json(messages);
    } catch (err) {
      log.warn({ err, sdkSessionId }, "Failed to get SDK session messages");
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const session = findChatSessionById(id);
  if (!session) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  const rows = listChatMessages(id);
  return c.json(rows.map(toChatMessageResponse));
});

// PUT /chat/sessions/:id
chatRouter.put("/sessions/:id", zValidator("json", updateChatSessionSchema as any), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");
  log.debug("PUT /chat/sessions/%s title=%s", id, body.title);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  const row = updateChatSession(id, { title: body.title });
  return c.json(row ? toChatSessionResponse(row) : null);
});

// DELETE /chat/sessions/:id
chatRouter.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("DELETE /chat/sessions/%s", id);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  deleteChatSession(id);
  broadcast({ type: "chat:session_deleted", payload: { id } });
  return c.body(null, 204);
});

// POST /chat
chatRouter.post("/", zValidator("json", chatRequestSchema as any), async (c) => {
  const body = c.req.valid("json");
  const { projectId, message, clientId, conversationId, explore, taskId } = body;
  let { sessionId: inputSessionId } = body;

  const project = findProjectById(projectId);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Resolve currently open task for context injection
  let currentTask: Task | null = null;
  if (taskId) {
    const row = findTaskById(taskId);
    if (row) currentTask = toTaskResponse(row);
  }

  // Resolve or auto-create a chat session
  let chatSessionId = inputSessionId ?? null;
  if (chatSessionId) {
    const existing = findChatSessionById(chatSessionId);
    if (!existing) {
      log.debug("Provided sessionId=%s not found, will auto-create", chatSessionId);
      chatSessionId = null;
    }
  }
  if (!chatSessionId) {
    const autoTitle = message.slice(0, 80);
    const session = createChatSession({ projectId, title: autoTitle });
    chatSessionId = session?.id ?? null;
    if (chatSessionId) {
      log.debug("Auto-created chat session sessionId=%s title=%s", chatSessionId, autoTitle);
      if (session) {
        broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
      }
    }
  }

  const chatConversationId = conversationId ?? crypto.randomUUID();
  log.info(
    {
      projectId,
      clientId,
      conversationId: chatConversationId,
      sessionId: chatSessionId,
      explore,
      taskId,
    },
    "Chat request started",
  );

  // Persist user message
  if (chatSessionId) {
    const userMsg = createChatMessage({ sessionId: chatSessionId, role: "user", content: message });
    log.debug("Persisting user message sessionId=%s messageId=%s", chatSessionId, userMsg?.id);
    updateChatSessionTimestamp(chatSessionId);
  }

  try {
    // Look up agentSessionId from DB for multi-turn resume
    const dbSession = chatSessionId ? findChatSessionById(chatSessionId) : null;
    const resumeAgentSessionId = dbSession?.agentSessionId ?? undefined;

    const prompt = explore ? `/aif-explore ${message}` : message;

    const stream = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: CLAUDE_PATH,
        cwd: project.rootPath,
        env: { ...process.env, HANDOFF_MODE: "1", ...(taskId ? { HANDOFF_TASK_ID: taskId } : {}) },
        permissionMode: getEnv().AGENT_BYPASS_PERMISSIONS ? "bypassPermissions" : "acceptEdits",
        ...(getEnv().AGENT_BYPASS_PERMISSIONS ? { allowDangerouslySkipPermissions: true } : {}),
        settingSources: ["project"],
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildContextAppend(project.name, currentTask),
        },
        ...(resumeAgentSessionId ? { resume: resumeAgentSessionId } : {}),
        maxTurns: 20,
      },
    });

    let agentSessionId: string | undefined;
    let fullAssistantResponse = "";

    const sendToken = (text: string) => {
      const tokenEvent: WsEvent = {
        type: "chat:token",
        payload: { conversationId: chatConversationId, token: text },
      };
      sendToClient(clientId, tokenEvent);
    };

    let hasStreamedTokens = false;

    for await (const msg of stream) {
      if (!msg || typeof msg !== "object" || !("type" in msg)) continue;
      const typed = msg as { type: string; [key: string]: unknown };

      // Capture session_id from init message for multi-turn resume
      if (
        typed.type === "system" &&
        typed.subtype === "init" &&
        typeof typed.session_id === "string"
      ) {
        agentSessionId = typed.session_id;
        if (chatSessionId) {
          updateChatSession(chatSessionId, { agentSessionId });
        }
        log.debug(
          { agentSessionId, conversationId: chatConversationId },
          "Chat agent session initialized",
        );
      }

      // Stream text tokens to client via WS
      if (typed.type === "stream_event") {
        const event = (
          typed as { event?: { type?: string; delta?: { type?: string; text?: string } } }
        ).event;
        if (
          event?.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          hasStreamedTokens = true;
          fullAssistantResponse += event.delta.text;
          sendToken(event.delta.text);
          log.debug(
            { conversationId: chatConversationId, tokenLength: event.delta.text.length },
            "Streamed chat token",
          );
        }
      }

      // Stream tool use summaries as visible text
      if (typed.type === "tool_use_summary" && typeof typed.summary === "string") {
        sendToken(`\n\n> ${typed.summary}\n\n`);
        log.debug({ conversationId: chatConversationId }, "Streamed tool use summary");
      }

      // Handle result message — surface errors and permission denials
      if (typed.type === "result") {
        if (typed.subtype === "success") {
          log.info({ conversationId: chatConversationId }, "Chat request completed successfully");

          // If no tokens were streamed (e.g. SDK returned a result without calling the model),
          // surface the result text directly so the user sees the response.
          if (!hasStreamedTokens && typeof typed.result === "string" && typed.result) {
            fullAssistantResponse += typed.result;
            sendToken(typed.result);
          }

          // Surface permission denials
          const denials = typed.permission_denials as
            | Array<{ tool_name: string; tool_input?: Record<string, unknown> }>
            | undefined;
          if (denials?.length) {
            const names = denials.map((d) => d.tool_name).join(", ");
            sendToken(
              `\n\n**Permission denied** for tool(s): ${names}. The operation was blocked by the current permission mode.\n`,
            );
          }
        } else {
          log.error(
            { conversationId: chatConversationId, subtype: typed.subtype },
            "Chat query ended with non-success",
          );

          // Surface error details and permission denials to the user
          const errors = typed.errors as string[] | undefined;
          const denials = typed.permission_denials as Array<{ tool_name: string }> | undefined;
          const parts: string[] = [];

          if (typed.subtype === "error_max_turns") {
            parts.push("**Reached max turns limit** — the agent stopped after 20 turns.");
          } else if (typed.subtype === "error_max_budget_usd") {
            parts.push("**Budget limit reached** — the agent exceeded the allowed cost.");
          } else if (errors?.length) {
            parts.push(`**Error:** ${errors.join("; ")}`);
          } else {
            parts.push(`**Error:** agent stopped unexpectedly (${String(typed.subtype)}).`);
          }

          if (denials?.length) {
            const names = denials.map((d) => d.tool_name).join(", ");
            parts.push(`**Permission denied** for: ${names}.`);
          }

          sendToken("\n\n" + parts.join("\n") + "\n");
        }
      }
    }

    // Persist assistant response
    if (chatSessionId && fullAssistantResponse) {
      createChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: fullAssistantResponse,
      });
      updateChatSessionTimestamp(chatSessionId);
      log.debug("Persisting assistant response sessionId=%s", chatSessionId);
    }

    // Signal completion
    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: { conversationId: chatConversationId },
    };
    sendToClient(clientId, doneEvent);

    log.info({ conversationId: chatConversationId }, "Chat request ended");

    return c.json({ conversationId: chatConversationId, sessionId: chatSessionId });
  } catch (err) {
    log.error({ err, conversationId: chatConversationId }, "Chat request failed");
    const classified = classifyChatError(err);

    const errorEvent: WsEvent = {
      type: "chat:error",
      payload: {
        conversationId: chatConversationId,
        message: classified.message,
        code: classified.code,
      },
    };
    sendToClient(clientId, errorEvent);

    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: { conversationId: chatConversationId },
    };
    sendToClient(clientId, doneEvent);

    return c.json({ error: classified.message, code: classified.code }, classified.status);
  }
});
