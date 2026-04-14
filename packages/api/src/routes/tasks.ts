import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger, parseAttachments, getProjectConfig, defaultsForMode } from "@aif/shared";
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
import {
  findProjectById,
  resolveEffectiveRuntimeProfile,
  updateTaskPositionOnly,
  type TaskRow,
} from "@aif/data";

const log = logger("tasks-route");

export const tasksRouter = new Hono();

function toTaskRouteResponse(task: TaskRow) {
  const response = toTaskResponse(task);
  const effective = resolveEffectiveRuntimeProfile({
    taskId: task.id,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId: null,
  });

  return {
    ...response,
    effectiveRuntime: {
      source: effective.source,
      profileId: effective.profile?.id ?? null,
      runtimeId: effective.profile?.runtimeId ?? null,
      providerId: effective.profile?.providerId ?? null,
      profileName: effective.profile?.name ?? null,
    },
  };
}

// POST /tasks/:id/broadcast — emit WS update for a task (used by agent process)
tasksRouter.post("/:id/broadcast", jsonValidator(broadcastTaskSchema), async (c) => {
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
  return c.json(allTasks.map(toTaskRouteResponse));
});

// POST /tasks — create
tasksRouter.post("/", jsonValidator(createTaskSchema), async (c) => {
  const body = c.req.valid("json");

  // Resolve planPath default from project config.yaml (if present)
  const project = findProjectById(body.projectId);
  const defaultPlanPath = project
    ? getProjectConfig(project.rootPath).paths.plan
    : ".ai-factory/PLAN.md";

  // Parallel-enabled projects enforce full mode and unique planPath
  if (project?.parallelEnabled) {
    body.plannerMode = "full";
  }

  // Fill omitted flag values from mode-driven defaults (mirror of web UI behavior).
  const modeDefaults = defaultsForMode(body.plannerMode);
  const resolvedSkipReview = body.skipReview ?? modeDefaults.skipReview;
  const resolvedPlanDocs = body.planDocs ?? modeDefaults.planDocs;
  const resolvedPlanTests = body.planTests ?? modeDefaults.planTests;
  if (
    body.skipReview === undefined ||
    body.planDocs === undefined ||
    body.planTests === undefined
  ) {
    log.debug(
      {
        plannerMode: body.plannerMode,
        filled: {
          skipReview: body.skipReview === undefined,
          planDocs: body.planDocs === undefined,
          planTests: body.planTests === undefined,
        },
      },
      "Applied mode-driven task flag defaults",
    );
  }

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
    planPath: body.planPath ?? defaultPlanPath,
    planDocs: resolvedPlanDocs,
    planTests: resolvedPlanTests,
    skipReview: resolvedSkipReview,
    useSubagents: body.useSubagents,
    maxReviewIterations: body.maxReviewIterations,
    paused: body.paused,
    runtimeProfileId: body.runtimeProfileId,
    modelOverride: body.modelOverride,
    runtimeOptions: body.runtimeOptions,
    roadmapAlias: body.roadmapAlias,
    tags: body.tags,
    scheduledAt: body.scheduledAt ?? null,
  });
  if (!created) return c.json({ error: "Failed to create task" }, 500);

  // Persist attachments to project files and update the task with path-based metadata
  if (body.attachments.length > 0) {
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
  return c.json(toTaskRouteResponse(final), 201);
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
  return c.json(toTaskRouteResponse(task));
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
    return new Response(new Uint8Array(buffer), { headers: c.res.headers });
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
    return new Response(new Uint8Array(buffer), { headers: c.res.headers });
  } catch {
    return c.json({ error: "Attachment file not found on disk" }, 404);
  }
});

// POST /tasks/:id/comments — create a human comment
tasksRouter.post("/:id/comments", jsonValidator(createTaskCommentSchema), async (c) => {
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
tasksRouter.put("/:id", jsonValidator(updateTaskSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Parallel-enabled projects enforce full mode
  const project = findProjectById(existing.projectId);
  if (project?.parallelEnabled) {
    if (body.plannerMode === "fast") {
      return c.json({ error: "Parallel-enabled projects require full planner mode" }, 400);
    }
  }

  const { plan, attachments: incomingAttachments, ...updatePayload } = body;

  // Mirror POST /tasks: when plannerMode changes, fill omitted flags from mode defaults.
  if (updatePayload.plannerMode !== undefined) {
    const modeDefaults = defaultsForMode(updatePayload.plannerMode);
    const filled = {
      skipReview: updatePayload.skipReview === undefined,
      planDocs: updatePayload.planDocs === undefined,
      planTests: updatePayload.planTests === undefined,
    };
    updatePayload.skipReview = updatePayload.skipReview ?? modeDefaults.skipReview;
    updatePayload.planDocs = updatePayload.planDocs ?? modeDefaults.planDocs;
    updatePayload.planTests = updatePayload.planTests ?? modeDefaults.planTests;
    if (filled.skipReview || filled.planDocs || filled.planTests) {
      log.debug(
        { taskId: id, plannerMode: updatePayload.plannerMode, filled },
        "Applied mode-driven task flag defaults on update",
      );
    }
  }

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
      (updatePayload as Record<string, unknown>).attachments = await persistAttachments(
        incomingAttachments,
        { projectRoot: project.rootPath, taskId: id },
      );
    }
  }

  const updated = updateTask(id, updatePayload);
  if (!updated) return c.json({ error: "Task not found after update" }, 500);
  log.debug({ taskId: id, fields: Object.keys(body) }, "Task updated");

  broadcast({ type: "task:updated", payload: toTaskResponse(updated) });
  return c.json(toTaskRouteResponse(updated));
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
  return c.json(toTaskRouteResponse(updated));
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
tasksRouter.post("/:id/events", jsonValidator(taskEventSchema), async (c) => {
  const { id } = c.req.param();
  const { event, deletePlanFile, commitOnApprove } = c.req.valid("json");
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
      return c.json({ error: handled.error }, handled.status as ContentfulStatusCode);
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

    // Fire-and-forget: run /aif-commit when approved with commit checkbox
    if (event === "approve_done" && commitOnApprove) {
      const { runCommitQuery } = await import("../services/commitGeneration.js");
      void runCommitQuery(handled.task.projectId);
    }

    return c.json(toTaskRouteResponse(handled.task));
  } catch (error) {
    log.error({ taskId: id, event, error }, "Task event handling failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// PATCH /tasks/:id/position — reorder within column
tasksRouter.patch("/:id/position", jsonValidator(reorderTaskSchema), async (c) => {
  const { id } = c.req.param();
  const { position } = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }

  updateTaskPositionOnly(id, position);
  const updated = findTaskById(id);
  if (!updated) return c.json({ error: "Task not found after reorder" }, 500);
  log.debug({ taskId: id, position }, "Task reordered");

  broadcast({ type: "task:updated", payload: toTaskResponse(updated) });
  return c.json(toTaskRouteResponse(updated));
});
