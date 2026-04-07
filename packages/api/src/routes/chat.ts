import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { z } from "zod";
import {
  createRuntimeWorkflowSpec,
  getResultSessionId,
  isRuntimeErrorCategory,
  RUNTIME_TRUST_TOKEN,
  resolveAdapterCapabilities,
  RuntimeTransport,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeRunInput,
} from "@aif/runtime";
import {
  logger,
  getEnv,
  type ChatMessageAttachment,
  type ChatSession,
  type ChatSessionMessage,
  type Task,
  type WsEvent,
} from "@aif/shared";
import {
  createChatMessage,
  createChatSession,
  deleteChatSession,
  findChatSessionById,
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  listChatMessages,
  listChatSessions,
  toChatMessageResponse,
  toChatSessionResponse,
  toRuntimeProfileResponse,
  toTaskResponse,
  updateChatSession,
  updateChatSessionTimestamp,
} from "@aif/data";
import { chatRequestSchema, createChatSessionSchema, updateChatSessionSchema } from "../schemas.js";
import { persistAttachments } from "../services/attachmentPersistence.js";
import { readAttachment } from "../services/attachmentStorage.js";
import { getCodexExecutionHooks } from "../services/codexExecutionHooks.js";
import { broadcast, sendToClient } from "../ws.js";
import {
  getCached,
  invalidateCache,
  sessionCacheKey,
  setCached,
} from "../services/sessionCache.js";
import {
  assertApiRuntimeCapabilities,
  getApiRuntimeRegistry,
  resolveApiRuntimeContext,
} from "../services/runtime.js";

const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

const CHAT_ACTIONS_PROMPT = `
Identity: You are AIFer.

You have special capabilities in this chat:

1. CREATE TASK: ONLY when the user explicitly asks to create a task (e.g. "создай задачу", "create a task", "добавь таск"), output a structured block. Do NOT create tasks unprompted or for casual messages:
<!--ACTION:CREATE_TASK-->
{"title": "Short task title", "description": "Detailed task description with context from the conversation", "isFix": false}
<!--/ACTION-->
Include this block in your response along with a brief explanation of the task you're creating. The user will see a confirmation card and can approve it.

Set "isFix" to true when the user describes a bug, defect, or asks to fix/repair/debug something (e.g. "исправь", "fix", "починить", "баг", "не работает", "сломалось"). When isFix is true, the agent pipeline will use the bug-fix workflow instead of the feature workflow. Default is false for new features, improvements, and refactoring.

2. TASK SUMMARY: When the user asks to summarize what was done on the current task (or any task you have context for), generate a concise summary covering: what was planned, what was implemented, review results, and current status.
`.trim();

const log = logger("chat-route");
const API_RUNTIME_LOG = "api-runtime";
type CreateChatSessionPayload = z.infer<typeof createChatSessionSchema>;
type UpdateChatSessionPayload = z.infer<typeof updateChatSessionSchema>;
type ChatRequestPayload = z.infer<typeof chatRequestSchema>;

interface VirtualRuntimeSessionRef {
  runtimeId: string;
  sessionId: string;
}

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

function normalizeRuntimeId(value: string): string {
  return value.trim().toLowerCase();
}

function formatVirtualRuntimeSessionId(
  runtimeId: string,
  runtimeSessionId: string,
  transport?: string,
): string {
  if (transport === RuntimeTransport.SDK || transport === undefined) {
    return `sdk:${runtimeSessionId}`;
  }
  return `runtime:${encodeURIComponent(runtimeId)}:${encodeURIComponent(runtimeSessionId)}`;
}

function parseVirtualRuntimeSessionId(
  id: string,
  fallbackRuntimeId?: string,
): VirtualRuntimeSessionRef | null {
  if (id.startsWith("sdk:")) {
    const sessionId = id.slice(4).trim();
    return sessionId
      ? { runtimeId: fallbackRuntimeId ?? getEnv().AIF_DEFAULT_RUNTIME_ID, sessionId }
      : null;
  }

  if (!id.startsWith("runtime:")) {
    return null;
  }

  const match = /^runtime:([^:]+):(.+)$/.exec(id);
  if (!match) return null;

  const runtimeId = decodeURIComponent(match[1] ?? "").trim();
  const sessionId = decodeURIComponent(match[2] ?? "").trim();

  if (!runtimeId || !sessionId) return null;
  return { runtimeId: normalizeRuntimeId(runtimeId), sessionId };
}

function runtimeSourceFromTransport(transport: string): "cli" | "agent" {
  return transport === RuntimeTransport.CLI ? "cli" : "agent";
}

function classifyChatError(err: unknown): {
  status: 429 | 500;
  code: string;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);

  if (isRuntimeErrorCategory(err, "rate_limit")) {
    return { status: 429, code: "CHAT_USAGE_LIMIT", message };
  }

  if (isRuntimeErrorCategory(err, "auth")) {
    return { status: 500, code: "CHAT_AUTH_ERROR", message };
  }

  return { status: 500, code: "CHAT_REQUEST_FAILED", message: "Chat request failed" };
}

/** Runtime-aware input sanitization. Uses adapter.sanitizeInput if available, otherwise passthrough. */
function sanitizeRuntimeInput(text: string, adapter?: RuntimeAdapter): string {
  return adapter?.sanitizeInput ? adapter.sanitizeInput(text) : text.trim();
}

/**
 * Strip the "Attached files:" block appended to user prompts.
 * Runtime adapters may store the full prompt; we only want the original user message.
 */
function stripAttachedFilesBlock(text: string): string {
  const idx = text.indexOf("\n\n---\nAttached files:\n");
  return idx !== -1 ? text.slice(0, idx) : text;
}

/**
 * Extract human-readable text from message payloads.
 * Returns only user-visible text — skips thinking/tool blocks.
 */
function extractMessageContent(message: unknown, adapter?: RuntimeAdapter): string {
  const sanitize = (t: string) => sanitizeRuntimeInput(t, adapter);

  if (typeof message === "string") return stripAttachedFilesBlock(sanitize(message));
  if (!message || typeof message !== "object") return "";

  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return stripAttachedFilesBlock(sanitize(msg.content));

  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (!b || typeof b !== "object") continue;

      if (b.type === "text" && typeof b.text === "string") {
        parts.push(sanitize(b.text));
      }
    }
    return stripAttachedFilesBlock(parts.join("\n\n").trim());
  }

  return "";
}

function eventRole(event: RuntimeEvent): "user" | "assistant" | null {
  const roleValue =
    event.data && typeof event.data === "object" && typeof event.data.role === "string"
      ? event.data.role
      : null;
  if (roleValue === "user" || roleValue === "assistant") {
    return roleValue;
  }
  return null;
}

function eventId(event: RuntimeEvent): string {
  const raw =
    event.data && typeof event.data === "object" && typeof event.data.id === "string"
      ? event.data.id
      : null;
  return raw ?? crypto.randomUUID();
}

function buildChatRuntimeWorkflow(prompt: string, systemPromptAppend: string) {
  return createRuntimeWorkflowSpec({
    workflowKind: "chat",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "resume_if_available",
    systemPromptAppend,
  });
}

async function resolveChatRuntimeAdapter(projectId: string, prompt: string, systemAppend: string) {
  const workflow = buildChatRuntimeWorkflow(prompt, systemAppend);
  const context = await resolveApiRuntimeContext({
    projectId,
    mode: "chat",
    workflow,
  });
  assertApiRuntimeCapabilities({
    adapter: context.adapter,
    resolvedProfile: context.resolvedProfile,
    workflow,
  });
  return { workflow, context };
}

async function getAdapterForRuntimeId(runtimeId: string): Promise<RuntimeAdapter> {
  const registry = await getApiRuntimeRegistry();
  return registry.resolveRuntime(runtimeId);
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

  const project = findProjectById(projectId);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // DB-backed web sessions
  const dbRows = listChatSessions(projectId);
  const dbSessions = dbRows.map(toChatSessionResponse);

  // Collect linked external runtime session IDs to avoid duplicates
  const linkedRuntimeSessionIds = new Set(
    dbRows.map((r) => r.runtimeSessionId ?? r.agentSessionId).filter(Boolean) as string[],
  );

  let runtimeSessions: ChatSession[] = [];
  const systemAppend = buildContextAppend(project.name, null);
  try {
    const { context } = await resolveChatRuntimeAdapter(
      projectId,
      "session-discovery",
      systemAppend,
    );
    const adapter = context.adapter;
    const runtimeId = context.resolvedProfile.runtimeId;
    const caps = resolveAdapterCapabilities(adapter, context.resolvedProfile.transport);
    if (!caps.supportsSessionList || !adapter.listSessions) {
      log.warn(
        {
          projectId,
          runtimeId,
          profileId: context.resolvedProfile.profileId,
        },
        "WARN [chat-route] Runtime does not support external session listing; returning DB sessions only",
      );
    } else {
      const cacheKey = sessionCacheKey(
        runtimeId,
        context.resolvedProfile.profileId,
        project.rootPath,
      );
      let listed =
        getCached<Awaited<ReturnType<NonNullable<typeof adapter.listSessions>>>>(cacheKey);
      if (!listed) {
        listed = await adapter.listSessions({
          runtimeId,
          providerId: context.resolvedProfile.providerId,
          profileId: context.resolvedProfile.profileId,
          projectRoot: project.rootPath,
          limit: 50,
          options: {
            ...context.resolvedProfile.options,
            ...(context.resolvedProfile.baseUrl
              ? { baseUrl: context.resolvedProfile.baseUrl }
              : {}),
          },
          headers: context.resolvedProfile.headers,
        });
        setCached(cacheKey, listed);
      }

      runtimeSessions = listed
        .filter((session) => !linkedRuntimeSessionIds.has(session.id))
        .map((session) => ({
          id: formatVirtualRuntimeSessionId(
            runtimeId,
            session.id,
            context.resolvedProfile.transport,
          ),
          projectId,
          title: session.title || "Untitled",
          agentSessionId: null,
          runtimeProfileId: context.resolvedProfile.profileId,
          runtimeSessionId: session.id,
          source: runtimeSourceFromTransport(context.resolvedProfile.transport),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }));

      log.debug(
        {
          projectId,
          runtimeId,
          profileId: context.resolvedProfile.profileId,
          discovered: listed.length,
          mergedRuntimeSessions: runtimeSessions.length,
          dbSessions: dbSessions.length,
        },
        "DEBUG [chat-route] Runtime session discovery completed",
      );
    }
  } catch (err) {
    log.warn(
      { err, projectId },
      "WARN [chat-route] Failed runtime session discovery; returning DB sessions only",
    );
  }

  // Merge, sort by updatedAt DESC, cap at 20
  const all = [...dbSessions, ...runtimeSessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  return c.json(all);
});

// POST /chat/sessions
chatRouter.post("/sessions", jsonValidator(createChatSessionSchema), async (c) => {
  const body = c.req.valid("json") as CreateChatSessionPayload;
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

  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.getSession) {
        return c.json({ error: "Runtime does not support session details" }, 404);
      }
      const info = await adapter.getSession({
        runtimeId: virtual.runtimeId,
        providerId: adapter.descriptor.providerId,
        profileId: null,
        sessionId: virtual.sessionId,
      });
      if (!info) {
        return c.json({ error: "Chat session not found" }, 404);
      }
      const session: ChatSession = {
        id,
        projectId: "",
        title: info.title || "Untitled",
        agentSessionId: null,
        runtimeProfileId: null,
        runtimeSessionId: info.id,
        source: "agent",
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
      };
      return c.json(session);
    } catch (err) {
      log.warn({ err, runtimeId: virtual.runtimeId }, "Failed to get runtime session info");
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

  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.listSessionEvents) {
        return c.json({ error: "Runtime does not support session message listing" }, 404);
      }

      const runtimeEvents = await adapter.listSessionEvents({
        runtimeId: virtual.runtimeId,
        providerId: adapter.descriptor.providerId,
        profileId: null,
        sessionId: virtual.sessionId,
      });

      const messages: ChatSessionMessage[] = runtimeEvents
        .map((event) => {
          const role = eventRole(event);
          const content = event.message ?? "";
          if (!role || !content.trim()) return null;
          return {
            id: eventId(event),
            sessionId: id,
            role,
            content: extractMessageContent(content, adapter),
            createdAt: event.timestamp,
          } as ChatSessionMessage;
        })
        .filter((message): message is ChatSessionMessage => Boolean(message));

      return c.json(messages);
    } catch (err) {
      log.warn(
        { err, runtimeId: virtual.runtimeId, runtimeSessionId: virtual.sessionId },
        "Failed to get runtime session messages",
      );
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const session = findChatSessionById(id);
  if (!session) {
    return c.json({ error: "Chat session not found" }, 404);
  }

  const project = findProjectById(session.projectId);
  const linkedRuntimeSessionId = session.runtimeSessionId ?? session.agentSessionId;

  if (linkedRuntimeSessionId && project) {
    let runtimeId = getEnv().AIF_DEFAULT_RUNTIME_ID;
    let providerId = getEnv().AIF_DEFAULT_PROVIDER_ID;
    let profileId = session.runtimeProfileId ?? null;
    let profileOptions: Record<string, unknown> | undefined;
    let profileHeaders: Record<string, string> | undefined;
    let profileBaseUrl: string | null = null;

    if (session.runtimeProfileId) {
      const profileRow = findRuntimeProfileById(session.runtimeProfileId);
      if (profileRow) {
        const profile = toRuntimeProfileResponse(profileRow);
        runtimeId = profile.runtimeId;
        providerId = profile.providerId;
        profileId = profile.id;
        profileOptions = profile.options;
        profileHeaders = profile.headers;
        profileBaseUrl = profile.baseUrl ?? null;
      }
    }

    try {
      const adapter = await getAdapterForRuntimeId(runtimeId);
      if (adapter.listSessionEvents) {
        const runtimeEvents = await adapter.listSessionEvents({
          runtimeId,
          providerId,
          profileId,
          projectRoot: project.rootPath,
          sessionId: linkedRuntimeSessionId,
          options: {
            ...(profileOptions ?? {}),
            ...(profileBaseUrl ? { baseUrl: profileBaseUrl } : {}),
          },
          headers: profileHeaders,
        });

        // Merge DB attachment metadata into runtime messages (attachments are persisted locally)
        const dbMessages = listChatMessages(id);
        const dbAttachmentsByContent = new Map<string, ChatSessionMessage["attachments"]>();
        for (const dbMsg of dbMessages) {
          const response = toChatMessageResponse(dbMsg);
          if (response.attachments?.length) {
            dbAttachmentsByContent.set(response.content, response.attachments);
          }
        }

        const messages: ChatSessionMessage[] = runtimeEvents
          .map((event) => {
            const role = eventRole(event);
            const rawContent = event.message ?? "";
            const content = extractMessageContent(rawContent, adapter);
            if (!role || !content.trim()) return null;
            return {
              id: eventId(event),
              sessionId: id,
              role,
              content,
              ...(dbAttachmentsByContent.has(content)
                ? { attachments: dbAttachmentsByContent.get(content) }
                : {}),
              createdAt: event.timestamp,
            } as ChatSessionMessage;
          })
          .filter((message): message is ChatSessionMessage => Boolean(message));

        return c.json(messages);
      }
    } catch (err) {
      log.warn(
        { err, runtimeId, runtimeSessionId: linkedRuntimeSessionId },
        "WARN [chat-route] Failed runtime session event load, falling back to DB messages",
      );
    }
  }

  const rows = listChatMessages(id);
  return c.json(rows.map(toChatMessageResponse));
});

// PUT /chat/sessions/:id
chatRouter.put("/sessions/:id", jsonValidator(updateChatSessionSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json") as UpdateChatSessionPayload;
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

// GET /chat/sessions/:sessionId/attachments/:filename — download a chat attachment
chatRouter.get("/sessions/:sessionId/attachments/:filename", async (c) => {
  const { sessionId, filename } = c.req.param();
  const session = findChatSessionById(sessionId);
  if (!session) return c.json({ error: "Chat session not found" }, 404);

  const project = findProjectById(session.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const messages = listChatMessages(sessionId);
  const decodedFilename = decodeURIComponent(filename);

  for (const msg of messages) {
    const response = toChatMessageResponse(msg);
    const attachment = response.attachments?.find((a) => a.name === decodedFilename);
    if (attachment?.path) {
      try {
        const buffer = await readAttachment(project.rootPath, attachment.path);
        c.header("Content-Type", attachment.mimeType || "application/octet-stream");
        c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
        c.header("Content-Length", String(buffer.length));
        return new Response(new Uint8Array(buffer), { headers: c.res.headers });
      } catch {
        return c.json({ error: "Attachment file not found on disk" }, 404);
      }
    }
  }

  return c.json({ error: "Attachment not found" }, 404);
});

// POST /chat
chatRouter.post("/", jsonValidator(chatRequestSchema), async (c) => {
  const body = c.req.valid("json") as ChatRequestPayload;
  const { projectId, message, clientId, conversationId, explore, taskId, attachments } = body;
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

  const systemAppend = buildContextAppend(project.name, currentTask);
  const runtimeResolution = await resolveChatRuntimeAdapter(projectId, message, systemAppend);
  const runtimeContext = runtimeResolution.context;
  const adapter = runtimeContext.adapter;
  const runtimeId = runtimeContext.resolvedProfile.runtimeId;
  const runtimeProfileId = runtimeContext.resolvedProfile.profileId;
  const runtimeProviderId = runtimeContext.resolvedProfile.providerId;

  // Resolve or auto-create a chat session
  let chatSessionId = inputSessionId ?? null;
  const incomingVirtual = chatSessionId ? parseVirtualRuntimeSessionId(chatSessionId) : null;

  // External runtime sessions are virtual — create a DB session linked to the runtime session
  if (incomingVirtual) {
    const autoTitle = message.slice(0, 80);
    const session = createChatSession({
      projectId,
      title: autoTitle,
      runtimeProfileId,
      runtimeSessionId: incomingVirtual.sessionId,
    });
    if (session) {
      chatSessionId = session.id;
      updateChatSession(session.id, {
        runtimeProfileId,
        runtimeSessionId: incomingVirtual.sessionId,
      });
      broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
    } else {
      chatSessionId = null;
    }
  } else if (chatSessionId) {
    const existing = findChatSessionById(chatSessionId);
    if (!existing) {
      log.debug("Provided sessionId=%s not found, will auto-create", chatSessionId);
      chatSessionId = null;
    }
  }

  if (!chatSessionId) {
    const autoTitle = message.slice(0, 80);
    const session = createChatSession({
      projectId,
      title: autoTitle,
      runtimeProfileId,
    });
    chatSessionId = session?.id ?? null;
    if (session) {
      broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
    }
  }

  const chatConversationId = conversationId ?? crypto.randomUUID();
  log.info(
    {
      projectId,
      clientId,
      conversationId: chatConversationId,
      sessionId: chatSessionId,
      runtimeId,
      runtimeProfileId,
      runtimeProviderId,
      logNamespace: API_RUNTIME_LOG,
      explore,
      taskId,
    },
    "INFO [api-runtime] Chat request started",
  );

  const dbSession = chatSessionId ? findChatSessionById(chatSessionId) : null;
  const resumeRuntimeSessionId =
    dbSession?.runtimeSessionId ?? dbSession?.agentSessionId ?? undefined;

  if (chatSessionId && !attachments?.length) {
    createChatMessage({ sessionId: chatSessionId, role: "user", content: message });
  }
  if (chatSessionId) {
    updateChatSessionTimestamp(chatSessionId);
  }

  try {
    // Persist file attachments to disk and build prompt with paths
    let prompt = explore ? `/aif-explore ${message}` : message;
    let savedAttachments: ChatMessageAttachment[] | undefined;
    if (attachments?.length && chatSessionId) {
      const persisted = await persistAttachments(attachments, {
        projectRoot: project.rootPath,
        chatSessionId,
      });
      savedAttachments = persisted
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, path: a.path }));
      const fileContext = persisted
        .map((f, i) => {
          const location = f.path ? `Path: ${f.path}` : "[metadata only]";
          return `File ${i + 1}: ${f.name} (${f.mimeType}, ${f.size} bytes)\n${location}`;
        })
        .join("\n\n");
      prompt = `${prompt}\n\n---\nAttached files:\n${fileContext}`;
    }

    if (chatSessionId && attachments?.length) {
      createChatMessage({
        sessionId: chatSessionId,
        role: "user",
        content: message,
        attachments: savedAttachments,
      });
    }

    const bypassPermissions = getEnv().AGENT_BYPASS_PERMISSIONS;
    let fullAssistantResponse = "";
    let hasStreamedTokens = false;

    const sendToken = (text: string) => {
      const tokenEvent: WsEvent = {
        type: "chat:token",
        payload: { conversationId: chatConversationId, token: text },
      };
      sendToClient(clientId, tokenEvent);
    };

    const onRuntimeEvent = (event: RuntimeEvent) => {
      if (event.type === "stream:text" && event.message) {
        hasStreamedTokens = true;
        fullAssistantResponse += event.message;
        sendToken(event.message);
        return;
      }

      if (event.type === "tool:summary" && event.message) {
        sendToken(`\n\n> ${event.message}\n\n`);
      }
    };

    const runInput: RuntimeRunInput = {
      runtimeId,
      providerId: runtimeProviderId,
      profileId: runtimeProfileId,
      workflowKind: "chat",
      transport: runtimeContext.resolvedProfile.transport,
      prompt,
      model: runtimeContext.resolvedProfile.model ?? undefined,
      sessionId: resumeRuntimeSessionId,
      resume: Boolean(resumeRuntimeSessionId),
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      headers: runtimeContext.resolvedProfile.headers,
      options: {
        ...runtimeContext.resolvedProfile.options,
        ...(runtimeContext.resolvedProfile.baseUrl
          ? { baseUrl: runtimeContext.resolvedProfile.baseUrl }
          : {}),
        ...(runtimeContext.resolvedProfile.apiKey
          ? { apiKey: runtimeContext.resolvedProfile.apiKey }
          : {}),
        ...(runtimeContext.resolvedProfile.apiKeyEnvVar
          ? { apiKeyEnvVar: runtimeContext.resolvedProfile.apiKeyEnvVar }
          : {}),
      },
      execution: {
        includePartialMessages: true,
        maxTurns: 20,
        onEvent: onRuntimeEvent,
        systemPromptAppend: systemAppend,
        environment: {
          HANDOFF_MODE: "1",
          ...(taskId ? { HANDOFF_TASK_ID: taskId } : {}),
        },
        hooks: {
          ...getCodexExecutionHooks({
            runtimeId,
            transport: runtimeContext.resolvedProfile.transport,
            bypassPermissions,
          }),
          permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
          allowDangerouslySkipPermissions: bypassPermissions,
          _trustToken: RUNTIME_TRUST_TOKEN,
          settings: { attribution: { commit: "", pr: "" } },
          settingSources: ["project"],
        },
      },
    };

    const chatCapsForResume = resolveAdapterCapabilities(
      adapter,
      runtimeContext.resolvedProfile.transport,
    );
    const canResume =
      Boolean(resumeRuntimeSessionId) &&
      chatCapsForResume.supportsResume &&
      Boolean(adapter.resume);
    const result =
      canResume && adapter.resume
        ? await adapter.resume({ ...runInput, sessionId: resumeRuntimeSessionId! })
        : await adapter.run({
            ...runInput,
            sessionId: undefined,
            resume: false,
          });

    const chatCaps = resolveAdapterCapabilities(adapter, runtimeContext.resolvedProfile.transport);
    const runtimeSessionId = getResultSessionId(result, chatCaps) ?? resumeRuntimeSessionId ?? null;
    if (chatSessionId && runtimeSessionId) {
      updateChatSession(chatSessionId, {
        runtimeProfileId,
        runtimeSessionId,
      });
      invalidateCache(sessionCacheKey(runtimeId, runtimeProfileId, project.rootPath));
      log.debug(
        {
          runtimeId,
          runtimeProfileId,
          runtimeSessionId,
          sessionId: chatSessionId,
        },
        "DEBUG [chat-route] Persisted runtime session link",
      );
    }

    if (!hasStreamedTokens && result.outputText) {
      fullAssistantResponse += result.outputText;
      sendToken(result.outputText);
    }

    // Persist assistant response in local chat history for both fresh and resumed runtime sessions.
    if (chatSessionId && fullAssistantResponse) {
      createChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: fullAssistantResponse,
      });
    }
    if (chatSessionId) {
      updateChatSessionTimestamp(chatSessionId);
    }

    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: { conversationId: chatConversationId },
    };
    sendToClient(clientId, doneEvent);

    return c.json({
      conversationId: chatConversationId,
      sessionId: chatSessionId,
      runtime: {
        runtimeId,
        profileId: runtimeProfileId,
        providerId: runtimeProviderId,
      },
      ...(savedAttachments?.length ? { attachments: savedAttachments } : {}),
    });
  } catch (err) {
    log.error(
      { err, runtimeId, runtimeProfileId, runtimeProviderId, conversationId: chatConversationId },
      "Chat request failed",
    );
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
