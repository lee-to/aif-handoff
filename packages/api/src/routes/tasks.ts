import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { logger, parseAttachments } from "@aif/shared";
import {
  createTaskSchema,
  updateTaskSchema,
  taskEventSchema,
  createTaskCommentSchema,
  reorderTaskSchema,
  broadcastTaskSchema,
} from "../schemas.js";
import { broadcast } from "../ws.js";
import { handleTaskEvent } from "../services/taskEvents.js";
import {
  persistAttachments,
  cleanupReplacedAttachments,
} from "../services/attachmentPersistence.js";
import { readAttachment } from "../services/attachmentStorage.js";
import {
  findTaskById,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listComments,
  createComment,
  updateComment,
  toTaskResponse,
  toCommentResponse,
  getTaskPlanFileStatus,
  updateTaskPlan,
  syncTaskPlanFromFile,
} from "../repositories/tasks.js";
import { findProjectById } from "../repositories/projects.js";

const log = logger("tasks-route");

export const tasksRouter = new Hono();

// POST /tasks/:id/broadcast — emit WS update for a task (used by agent process)
tasksRouter.post("/:id/broadcast", zValidator("json", broadcastTaskSchema), async (c) => {
  const { id } = c.req.param();
  const { type } = c.req.valid("json");
  const task = findTaskById(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  broadcast({ type, payload: toTaskResponse(task) });
  log.debug({ taskId: id, type }, "Task WS broadcast triggered");
  return c.json({ success: true });
});

// GET /tasks?projectId=xxx — list by project, sorted by status order + position
tasksRouter.get("/", (c) => {
  const projectId = c.req.query("projectId") || undefined;
  if (projectId && !/^[0-9a-f-]{36}$/i.test(projectId)) {
    return c.json({ error: "Invalid projectId format" }, 400);
  }

  const allTasks = listTasks(projectId);
  log.debug({ count: allTasks.length, projectId }, "Listed tasks");
  return c.json(allTasks.map(toTaskResponse));
});

// POST /tasks — create
tasksRouter.post("/", zValidator("json", createTaskSchema), async (c) => {
  const body = c.req.valid("json");

  // Pre-create the task to get an ID, then persist attachments to storage
  const created = createTask({
    projectId: body.projectId,
    title: body.title,
    description: body.description,
    attachments: [],
    priority: body.priority,
    autoMode: body.autoMode,
    isFix: body.isFix,
    plannerMode: body.plannerMode,
    planPath: body.planPath,
    planDocs: body.planDocs,
    planTests: body.planTests,
    skipReview: body.skipReview,
    roadmapAlias: body.roadmapAlias,
    tags: body.tags,
  });
  if (!created) return c.json({ error: "Failed to create task" }, 500);

  // Persist attachments to project files and update the task with path-based metadata
  if (body.attachments.length > 0) {
    const project = findProjectById(body.projectId);
    if (project) {
      const persisted = await persistAttachments(body.attachments, {
        projectRoot: project.rootPath,
        taskId: created.id,
      });
      updateTask(created.id, { attachments: persisted });
    }
  }

  const final = findTaskById(created.id) ?? created;
  log.debug(
    {
      taskId: final.id,
      title: body.title,
      roadmapAlias: body.roadmapAlias,
      tagCount: body.tags?.length,
      attachmentCount: body.attachments.length,
    },
    "Task created",
  );

  broadcast({ type: "task:created", payload: toTaskResponse(final) });
  // Wake coordinator when a new task is created (may need immediate processing)
  broadcast({ type: "agent:wake", payload: { id: final.id } });
  return c.json(toTaskResponse(final), 201);
});

// GET /tasks/:id — full detail
tasksRouter.get("/:id", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    log.debug({ taskId: id }, "Task not found");
    return c.json({ error: "Task not found" }, 404);
  }

  log.debug({ taskId: id }, "Task fetched");
  return c.json(toTaskResponse(task));
});

// GET /tasks/:id/attachments/:filename — download a task attachment
tasksRouter.get("/:id/attachments/:filename", async (c) => {
  const { id, filename } = c.req.param();
  const task = findTaskById(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const project = findProjectById(task.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const attachments = parseAttachments(task.attachments);
  const attachment = attachments.find((a) => a.name === decodeURIComponent(filename));
  if (!attachment?.path) return c.json({ error: "Attachment not found" }, 404);

  try {
    const buffer = await readAttachment(project.rootPath, attachment.path);
    c.header("Content-Type", attachment.mimeType || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
    c.header("Content-Length", String(buffer.length));
    return c.body(buffer);
  } catch {
    return c.json({ error: "Attachment file not found on disk" }, 404);
  }
});

// GET /tasks/:id/plan-file-status — check if canonical physical plan file already exists
tasksRouter.get("/:id/plan-file-status", (c) => {
  const { id } = c.req.param();
  const status = getTaskPlanFileStatus(id);
  if (!status) {
    return c.json({ error: "Task or project not found" }, 404);
  }

  return c.json(status);
});

// GET /tasks/:id/comments — list comments
tasksRouter.get("/:id/comments", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const comments = listComments(id);
  return c.json(comments.map(toCommentResponse));
});

// GET /tasks/:id/comments/:commentId/attachments/:filename — download a comment attachment
tasksRouter.get("/:id/comments/:commentId/attachments/:filename", async (c) => {
  const { id, commentId, filename } = c.req.param();
  const task = findTaskById(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const project = findProjectById(task.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const comments = listComments(id);
  const comment = comments.find((cm) => cm.id === commentId);
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const attachments = parseAttachments(comment.attachments);
  const attachment = attachments.find((a) => a.name === decodeURIComponent(filename));
  if (!attachment?.path) return c.json({ error: "Attachment not found" }, 404);

  try {
    const buffer = await readAttachment(project.rootPath, attachment.path);
    c.header("Content-Type", attachment.mimeType || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
    c.header("Content-Length", String(buffer.length));
    return c.body(buffer);
  } catch {
    return c.json({ error: "Attachment file not found on disk" }, 404);
  }
});

// POST /tasks/:id/comments — create a human comment
tasksRouter.post("/:id/comments", zValidator("json", createTaskCommentSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Create comment first to get its DB-assigned ID
  const created = createComment({
    taskId: id,
    message: body.message,
    attachments: [],
  });
  if (!created) return c.json({ error: "Failed to create comment" }, 500);

  // Persist attachments to project files using the real comment ID, then update
  if (body.attachments.length > 0) {
    const project = findProjectById(task.projectId);
    if (project) {
      const persisted = await persistAttachments(body.attachments, {
        projectRoot: project.rootPath,
        taskId: id,
        commentId: created.id,
      });
      const updated = updateComment(created.id, { attachments: persisted });
      return c.json(toCommentResponse(updated ?? created), 201);
    }
  }

  return c.json(toCommentResponse(created), 201);
});

// PUT /tasks/:id — update fields
tasksRouter.put("/:id", zValidator("json", updateTaskSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  const { plan, attachments: incomingAttachments, ...updatePayload } = body;

  const hasPlanUpdate = Object.prototype.hasOwnProperty.call(body, "plan");
  if (hasPlanUpdate) {
    try {
      updateTaskPlan(id, plan ?? null, existing.isFix, existing.planPath);
    } catch {
      return c.json({ error: "Project not found for task" }, 404);
    }
  }

  // Persist new attachments to project files and clean up replaced ones
  if (incomingAttachments !== undefined) {
    const project = findProjectById(existing.projectId);
    if (project) {
      const oldAttachments = parseAttachments(existing.attachments);
      cleanupReplacedAttachments(project.rootPath, oldAttachments, incomingAttachments);
      const persisted = await persistAttachments(incomingAttachments, {
        projectRoot: project.rootPath,
        taskId: id,
      });
      (updatePayload as Record<string, unknown>).attachments = persisted;
    }
  }

  const updated = updateTask(id, updatePayload);
  if (!updated) return c.json({ error: "Task not found after update" }, 500);
  log.debug({ taskId: id, fields: Object.keys(body) }, "Task updated");

  broadcast({ type: "task:updated", payload: toTaskResponse(updated) });
  return c.json(toTaskResponse(updated));
});

// POST /tasks/:id/sync-plan — sync DB plan with physical plan file
tasksRouter.post("/:id/sync-plan", (c) => {
  const { id } = c.req.param();
  const result = syncTaskPlanFromFile(id);
  if (!result) {
    return c.json({ error: "Task or project not found" }, 404);
  }
  if (!result.synced) {
    return c.json({ error: "Plan file not found" }, 404);
  }

  const updated = updateTask(id, {});
  if (!updated) return c.json({ error: "Task not found after sync" }, 500);
  log.debug({ taskId: id }, "Task plan synced from physical file");

  broadcast({ type: "task:updated", payload: toTaskResponse(updated) });
  return c.json(toTaskResponse(updated));
});

// DELETE /tasks/:id
tasksRouter.delete("/:id", (c) => {
  const { id } = c.req.param();
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  deleteTask(id);
  log.debug({ taskId: id }, "Task deleted");

  broadcast({ type: "task:deleted", payload: { id } });
  return c.json({ success: true });
});

// POST /tasks/:id/events — apply a human action through state machine
tasksRouter.post("/:id/events", zValidator("json", taskEventSchema), async (c) => {
  const { id } = c.req.param();
  const { event, deletePlanFile } = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  try {
    const handled = await handleTaskEvent({
      taskId: id,
      event,
      deletePlanFile,
    });
    if (!handled.ok) {
      return c.json({ error: handled.error }, handled.status);
    }

    log.debug(
      { taskId: id, from: existing.status, to: handled.task.status, event },
      "Task state transition applied",
    );
    broadcast({
      type: handled.broadcastType,
      payload: toTaskResponse(handled.task),
    });
    // Wake coordinator when task transitions may require agent processing
    if (handled.broadcastType === "task:moved") {
      broadcast({ type: "agent:wake", payload: { id: handled.task.id } });
    }
    return c.json(toTaskResponse(handled.task));
  } catch (error) {
    log.error({ taskId: id, event, error }, "Task event handling failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// PATCH /tasks/:id/position — reorder within column
tasksRouter.patch("/:id/position", zValidator("json", reorderTaskSchema), async (c) => {
  const { id } = c.req.param();
  const { position } = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  const updated = updateTask(id, { position });
  if (!updated) return c.json({ error: "Task not found after reorder" }, 500);
  log.debug({ taskId: id, position }, "Task reordered");

  broadcast({ type: "task:updated", payload: toTaskResponse(updated) });
  return c.json(toTaskResponse(updated));
});
