import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger, getEnv } from "@aif/shared";
import { findProjectById } from "../repositories/projects.js";
import { findTaskById, toTaskResponse } from "../repositories/tasks.js";
import { chatRequestSchema } from "../schemas.js";
import { sendToClient } from "../ws.js";
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

// Track active conversations for multi-turn resume
const conversationSessions = new Map<string, string>();

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

export const chatRouter = new Hono();

// POST /chat
chatRouter.post("/", zValidator("json", chatRequestSchema as any), async (c) => {
  const body = c.req.valid("json");
  const { projectId, message, clientId, conversationId, explore, taskId } = body;

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

  const chatConversationId = conversationId ?? crypto.randomUUID();
  log.info(
    { projectId, clientId, conversationId: chatConversationId, explore, taskId },
    "Chat request started",
  );

  try {
    const resumeSessionId = conversationId ? conversationSessions.get(conversationId) : undefined;

    const prompt = explore ? `/aif-explore ${message}` : message;

    const stream = query({
      prompt,
      options: {
        cwd: project.rootPath,
        permissionMode: getEnv().AGENT_BYPASS_PERMISSIONS ? "bypassPermissions" : "acceptEdits",
        ...(getEnv().AGENT_BYPASS_PERMISSIONS ? { allowDangerouslySkipPermissions: true } : {}),
        settingSources: ["project"],
        includePartialMessages: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildContextAppend(project.name, currentTask),
        },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        maxTurns: 20,
      },
    });

    let sessionId: string | undefined;

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
        sessionId = typed.session_id;
        conversationSessions.set(chatConversationId, sessionId);
        log.debug({ sessionId, conversationId: chatConversationId }, "Chat session initialized");
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

    // Signal completion
    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: { conversationId: chatConversationId },
    };
    sendToClient(clientId, doneEvent);

    log.info({ conversationId: chatConversationId }, "Chat request ended");

    return c.json({ conversationId: chatConversationId });
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
