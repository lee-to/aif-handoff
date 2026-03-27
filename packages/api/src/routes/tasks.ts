import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, asc } from "drizzle-orm";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyHumanTaskEvent, getDb, tasks, taskComments, projects, logger } from "@aif/shared";
import type { Task } from "@aif/shared";
import {
  createTaskSchema,
  updateTaskSchema,
  taskEventSchema,
  createTaskCommentSchema,
  reorderTaskSchema,
  broadcastTaskSchema,
} from "../schemas.js";
import { broadcast } from "../ws.js";

const log = logger("tasks-route");

export const tasksRouter = new Hono();

function getTaskById(id: string) {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return { db, task };
}

function parseAttachments(raw: string | null): Array<{
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "file",
        mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
        size: typeof item.size === "number" ? item.size : 0,
        content: typeof item.content === "string" ? item.content : null,
      }));
  } catch {
    return [];
  }
}

function toTaskResponse(task: typeof tasks.$inferSelect): Task {
  const { attachments, ...rest } = task;
  return {
    ...rest,
    attachments: parseAttachments(attachments),
  };
}

function formatLatestCommentForPrompt(comment: typeof taskComments.$inferSelect): string {
  const attachments = parseAttachments(comment.attachments);
  const attachmentLines = attachments.length
    ? attachments
        .map((file, index) => {
          const contentBlock = file.content
            ? `\n     content:\n${file.content
                .slice(0, 4000)
                .split("\n")
                .map((line) => `       ${line}`)
                .join("\n")}`
            : "\n     content: [not provided]";
          return `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)${contentBlock}`;
        })
        .join("\n")
    : "none";

  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    attachmentLines,
  ].join("\n");
}

async function runFastFixQuery(input: {
  task: typeof tasks.$inferSelect;
  latestComment: typeof taskComments.$inferSelect;
  projectRoot: string;
  previousPlan: string;
  priorAttempt?: string;
  shouldTryFileUpdate?: boolean;
}): Promise<string> {
  const includeFileUpdateStep = input.shouldTryFileUpdate ?? true;
  const prompt = input.priorAttempt
    ? `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.task.title}

TASK DESCRIPTION:
${input.task.description}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

PRIOR ATTEMPT THAT WAS TOO SHORT (do not use as final output):
<<<PRIOR_ATTEMPT
${input.priorAttempt}
PRIOR_ATTEMPT

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${includeFileUpdateStep
  ? "4) Also update the original plan file in the workspace (if you can access files/tools): find the existing source plan markdown that matches CURRENT PLAN and overwrite it with the FULL updated plan.\n5) Output markdown only in your final response."
  : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."}`
    : `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.task.title}

TASK DESCRIPTION:
${input.task.description}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${includeFileUpdateStep
  ? "4) Also update the original plan file in the workspace (if you can access files/tools): find the existing source plan markdown that matches CURRENT PLAN and overwrite it with the FULL updated plan.\n5) Output markdown only in your final response."
  : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."}`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      cwd: input.projectRoot,
      settingSources: ["project"],
      model: "haiku",
      maxThinkingTokens: 1024,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(includeFileUpdateStep
          ? {}
          : { append: "Do not use tools or subagents. Reply directly with markdown only." }),
      },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") {
      throw new Error(`Fast fix failed: ${message.subtype}`);
    }
    resultText = message.result.trim();
  }

  if (!resultText) {
    throw new Error("Fast fix did not return updated plan text");
  }
  return resultText;
}

function extractHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").toLowerCase());
}

function looksLikeFullPlanUpdate(previousPlan: string, updatedPlan: string): boolean {
  const prev = previousPlan.trim();
  const next = updatedPlan.trim();
  if (!prev) return next.length > 0;
  if (!next) return false;
  const minLength = prev.length < 120
    ? Math.max(10, Math.floor(prev.length * 0.6))
    : Math.max(80, Math.floor(prev.length * 0.5));
  if (next.length < minLength) {
    return false;
  }

  const prevHeadings = extractHeadings(prev);
  if (prev.length < 400 || prevHeadings.length === 0) return true;
  const nextHeadings = new Set(extractHeadings(next));
  return prevHeadings.some((heading) => nextHeadings.has(heading));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

// POST /tasks/:id/broadcast — emit WS update for a task (used by agent process)
tasksRouter.post(
  "/:id/broadcast",
  zValidator("json", broadcastTaskSchema),
  async (c) => {
    const { id } = c.req.param();
    const { type } = c.req.valid("json");
    const { task } = getTaskById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    broadcast({ type, payload: toTaskResponse(task) });
    log.debug({ taskId: id, type }, "Task WS broadcast triggered");
    return c.json({ success: true });
  }
);

// GET /tasks?projectId=xxx — list by project, sorted by status order + position
tasksRouter.get("/", (c) => {
  const projectId = c.req.query("projectId");
  const db = getDb();

  let allTasks;
  if (projectId) {
    allTasks = db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.status), asc(tasks.position))
      .all();
  } else {
    allTasks = db
      .select()
      .from(tasks)
      .orderBy(asc(tasks.status), asc(tasks.position))
      .all();
  }

  log.debug({ count: allTasks.length, projectId }, "Listed tasks");
  return c.json(allTasks.map((task) => toTaskResponse(task)));
});

// POST /tasks — create
tasksRouter.post("/", zValidator("json", createTaskSchema), async (c) => {
  const body = c.req.valid("json");
  const db = getDb();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(tasks)
    .values({
      id,
      projectId: body.projectId,
      title: body.title,
      description: body.description,
      attachments: JSON.stringify(body.attachments ?? []),
      priority: body.priority,
      autoMode: body.autoMode,
      isFix: body.isFix,
      reworkRequested: false,
      status: "backlog",
      position: 1000.0,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const created = db.select().from(tasks).where(eq(tasks.id, id)).get();
  log.debug({ taskId: id, title: body.title }, "Task created");

  broadcast({
    type: "task:created",
    payload: toTaskResponse(created!),
  });
  return c.json(toTaskResponse(created!), 201);
});

// GET /tasks/:id — full detail
tasksRouter.get("/:id", (c) => {
  const { id } = c.req.param();
  const { task } = getTaskById(id);
  if (!task) {
    log.debug({ taskId: id }, "Task not found");
    return c.json({ error: "Task not found" }, 404);
  }

  log.debug({ taskId: id }, "Task fetched");
  return c.json(toTaskResponse(task));
});

// GET /tasks/:id/comments — list comments
tasksRouter.get("/:id/comments", (c) => {
  const { id } = c.req.param();
  const { db, task } = getTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const comments = db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, id))
    .orderBy(asc(taskComments.createdAt))
    .all()
    .map((comment) => ({
      id: comment.id,
      taskId: comment.taskId,
      author: comment.author,
      message: comment.message,
      attachments: parseAttachments(comment.attachments),
      createdAt: comment.createdAt,
    }));

  return c.json(comments);
});

// POST /tasks/:id/comments — create a human comment
tasksRouter.post(
  "/:id/comments",
  zValidator("json", createTaskCommentSchema),
  (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json");
    const { db, task } = getTaskById(id);
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const commentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const attachments = body.attachments ?? [];

    db.insert(taskComments)
      .values({
        id: commentId,
        taskId: id,
        author: "human",
        message: body.message,
        attachments: JSON.stringify(attachments),
        createdAt: now,
      })
      .run();

    const created = db
      .select()
      .from(taskComments)
      .where(eq(taskComments.id, commentId))
      .get();

    return c.json({
      id: created!.id,
      taskId: created!.taskId,
      author: created!.author,
      message: created!.message,
      attachments: parseAttachments(created!.attachments),
      createdAt: created!.createdAt,
    }, 201);
  }
);

// PUT /tasks/:id — update fields
tasksRouter.put("/:id", zValidator("json", updateTaskSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const { db, task: existing } = getTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  const { attachments, ...restBody } = body;
  const updatePayload = {
    ...restBody,
    updatedAt: new Date().toISOString(),
  };
  if (attachments) {
    Object.assign(updatePayload, { attachments: JSON.stringify(attachments) });
  }

  db.update(tasks)
    .set(updatePayload)
    .where(eq(tasks.id, id))
    .run();

  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
  log.debug({ taskId: id, fields: Object.keys(body) }, "Task updated");

  broadcast({
    type: "task:updated",
    payload: toTaskResponse(updated!),
  });
  return c.json(toTaskResponse(updated!));
});

// POST /tasks/:id/sync-plan — sync DB plan with physical plan file
tasksRouter.post("/:id/sync-plan", (c) => {
  const { id } = c.req.param();
  const { db, task: existing } = getTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  const project = db.select().from(projects).where(eq(projects.id, existing.projectId)).get();
  if (!project) {
    return c.json({ error: "Project not found for task" }, 404);
  }

  const canonicalPlanPath = resolve(
    project.rootPath,
    existing.isFix ? ".ai-factory/FIX_PLAN.md" : ".ai-factory/PLAN.md"
  );
  if (!existsSync(canonicalPlanPath)) {
    return c.json({ error: `Plan file not found: ${canonicalPlanPath}` }, 404);
  }

  const filePlan = readFileSync(canonicalPlanPath, "utf8");
  const normalizedPlan = filePlan.trim().length > 0 ? filePlan : null;

  db.update(tasks)
    .set({
      plan: normalizedPlan,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, id))
    .run();

  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
  log.debug({ taskId: id, canonicalPlanPath }, "Task plan synced from physical file");

  broadcast({
    type: "task:updated",
    payload: toTaskResponse(updated!),
  });
  return c.json(toTaskResponse(updated!));
});

// DELETE /tasks/:id
tasksRouter.delete("/:id", (c) => {
  const { id } = c.req.param();
  const { db, task: existing } = getTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  db.delete(tasks).where(eq(tasks.id, id)).run();
  db.delete(taskComments).where(eq(taskComments.taskId, id)).run();
  log.debug({ taskId: id }, "Task deleted");

  broadcast({ type: "task:deleted", payload: { id } });
  return c.json({ success: true });
});

// POST /tasks/:id/events — apply a human action through state machine
tasksRouter.post(
  "/:id/events",
  zValidator("json", taskEventSchema),
  async (c) => {
    const { id } = c.req.param();
    const { event } = c.req.valid("json");
    const { db, task: existing } = getTaskById(id);
    if (!existing) {
      return c.json({ error: "Task not found" }, 404);
    }

    if (event === "fast_fix") {
      if (existing.status !== "plan_ready") {
        return c.json({ error: "fast_fix is only allowed from plan_ready" }, 409);
      }
      if (existing.autoMode) {
        return c.json({ error: "fast_fix is not needed when autoMode=true" }, 409);
      }

      const latestComment = db
        .select()
        .from(taskComments)
        .where(eq(taskComments.taskId, id))
        .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
        .all()
        .filter((comment) => comment.author === "human")
        .at(-1);
      if (!latestComment) {
        return c.json({ error: "fast_fix requires a human comment with requested fix" }, 409);
      }

      const project = db.select().from(projects).where(eq(projects.id, existing.projectId)).get();
      if (!project) {
        return c.json({ error: "Project not found for task" }, 404);
      }

      try {
        const previousPlan = existing.plan?.trim() ?? "";
        if (!previousPlan) {
          return c.json({ error: "fast_fix requires an existing plan on the task" }, 409);
        }

        let firstAttempt = "";
        try {
          firstAttempt = await withTimeout(
            runFastFixQuery({
              task: existing,
              latestComment,
              projectRoot: project.rootPath,
              previousPlan,
              shouldTryFileUpdate: true,
            }),
            90_000,
            "Fast fix query timed out"
          );
        } catch (error) {
          log.warn({ taskId: id, error }, "Fast fix file-update attempt failed, will fallback");
        }

        const updatedPlan = looksLikeFullPlanUpdate(previousPlan, firstAttempt)
          ? firstAttempt
          : await withTimeout(
              runFastFixQuery({
                task: existing,
                latestComment,
                projectRoot: project.rootPath,
                previousPlan,
                priorAttempt: firstAttempt || undefined,
                shouldTryFileUpdate: false,
              }),
              90_000,
              "Fast fix query timed out"
            );

        if (!looksLikeFullPlanUpdate(previousPlan, updatedPlan)) {
          throw new Error("Fast fix result omitted existing plan content. Plan was left unchanged.");
        }

        const canonicalPlanPath = resolve(
          project.rootPath,
          existing.isFix ? ".ai-factory/FIX_PLAN.md" : ".ai-factory/PLAN.md"
        );
        if (existsSync(canonicalPlanPath)) {
          writeFileSync(canonicalPlanPath, `${updatedPlan.trimEnd()}\n`, "utf8");
        } else {
          log.warn(
            { taskId: id, canonicalPlanPath },
            "Canonical plan file not found, skipping physical file update"
          );
        }

        db.update(tasks)
          .set({
            plan: updatedPlan,
            reworkRequested: false,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, id))
          .run();

        const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
        if (!updated) {
          return c.json({ error: "Task not found" }, 404);
        }

        log.debug({ taskId: id, event }, "Task plan fast-fix applied");
        broadcast({
          type: "task:updated",
          payload: toTaskResponse(updated),
        });
        return c.json(toTaskResponse(updated));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ taskId: id, event, error }, "Fast fix query failed");
        return c.json({ error: message }, 500);
      }
    }

    const transition = applyHumanTaskEvent(toTaskResponse(existing), event);
    if (!transition.ok) {
      return c.json({ error: transition.error }, 409);
    }

    const nowIso = new Date().toISOString();
    db.update(tasks)
      .set({ ...transition.patch, lastHeartbeatAt: nowIso, updatedAt: nowIso })
      .where(eq(tasks.id, id))
      .run();

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    log.debug(
      { taskId: id, from: existing.status, to: updated?.status, event },
      "Task state transition applied"
    );

    broadcast({
      type: "task:moved",
      payload: toTaskResponse(updated!),
    });
    return c.json(toTaskResponse(updated!));
  }
);

// PATCH /tasks/:id/position — reorder within column
tasksRouter.patch(
  "/:id/position",
  zValidator("json", reorderTaskSchema),
  async (c) => {
    const { id } = c.req.param();
    const { position } = c.req.valid("json");
    const { db, task: existing } = getTaskById(id);
    if (!existing) {
      return c.json({ error: "Task not found" }, 404);
    }

    db.update(tasks)
      .set({ position, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    log.debug({ taskId: id, position }, "Task reordered");

    broadcast({
      type: "task:updated",
      payload: toTaskResponse(updated!),
    });
    return c.json(toTaskResponse(updated!));
  }
);
