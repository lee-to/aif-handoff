import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { internalBroadcastAuth } from "../middleware/internalBroadcastAuth.js";
import { logger, getProjectConfig } from "@aif/shared";
import { findRuntimeProfileById, findTaskById } from "@aif/data";
import {
  createProjectSchema,
  roadmapImportSchema,
  roadmapGenerateSchema,
  broadcastProjectSchema,
  autoQueueModeSchema,
} from "../schemas.js";
import { getAutoQueueMode, setAutoQueueMode } from "@aif/data";
import { broadcast } from "../ws.js";
import {
  listProjects,
  findProjectById,
  createProject,
  updateProject,
  deleteProject,
  getProjectMcpServers,
} from "../repositories/projects.js";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import {
  generateRoadmapFile,
  generateRoadmapTasks,
  importGeneratedTasks,
  RoadmapGenerationError,
} from "../services/roadmapGeneration.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";

const log = logger("projects-route");

export const projectsRouter = new Hono();

// GET /projects
projectsRouter.get("/", (c) => {
  const all = listProjects();
  log.debug({ count: all.length }, "Listed all projects");
  return c.json(all);
});

// POST /projects
projectsRouter.post("/", jsonValidator(createProjectSchema), async (c) => {
  const body = c.req.valid("json");
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: null,
    selections: {
      defaultTaskRuntimeProfileId: body.defaultTaskRuntimeProfileId,
      defaultPlanRuntimeProfileId: body.defaultPlanRuntimeProfileId,
      defaultReviewRuntimeProfileId: body.defaultReviewRuntimeProfileId,
      defaultChatRuntimeProfileId: body.defaultChatRuntimeProfileId,
    },
  });
  if (runtimeValidation) {
    log.warn({ fieldErrors: runtimeValidation.fieldErrors }, "Rejected invalid project defaults");
    return c.json(runtimeValidation, 400);
  }
  const { project: created, pathError, initError } = await createProject(body);
  if (pathError) return c.json({ error: pathError }, 400);
  if (initError) return c.json({ error: initError }, 500);
  if (!created) return c.json({ error: "Failed to create project" }, 500);

  log.debug({ projectId: created.id, name: body.name }, "Project created");
  broadcast({ type: "project:created", payload: created });
  return c.json(created, 201);
});

// PUT /projects/:id
projectsRouter.put("/:id", jsonValidator(createProjectSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const existing = findProjectById(id);
  if (!existing) {
    return c.json({ error: "Project not found" }, 404);
  }

  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: id,
    selections: {
      defaultTaskRuntimeProfileId: body.defaultTaskRuntimeProfileId,
      defaultPlanRuntimeProfileId: body.defaultPlanRuntimeProfileId,
      defaultReviewRuntimeProfileId: body.defaultReviewRuntimeProfileId,
      defaultChatRuntimeProfileId: body.defaultChatRuntimeProfileId,
    },
  });
  if (runtimeValidation) {
    log.warn(
      { projectId: id, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid project defaults",
    );
    return c.json(runtimeValidation, 400);
  }

  const { project: updated, pathError } = updateProject(id, body);
  if (pathError) return c.json({ error: pathError }, 400);

  log.debug({ projectId: id }, "Project updated");
  return c.json(updated);
});

// GET /projects/:id/mcp — read .mcp.json from project directory
projectsRouter.get("/:id/mcp", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ mcpServers: getProjectMcpServers(id) });
});

// GET /projects/:id/defaults — return resolved config defaults for a project
projectsRouter.get("/:id/defaults", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const cfg = getProjectConfig(project.rootPath);
  return c.json({ paths: cfg.paths, workflow: cfg.workflow });
});

// GET /projects/:id/roadmap/status — check if ROADMAP.md exists for the project
projectsRouter.get("/:id/roadmap/status", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const cfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, cfg.paths.roadmap);
  const exists = existsSync(roadmapPath);
  log.debug({ projectId: id, roadmapPath, exists }, "Roadmap status check");
  if (exists) {
    log.info({ projectId: id }, "ROADMAP.md found");
  }

  return c.json({ exists });
});

// POST /projects/:id/roadmap/generate — start async roadmap generation + import
projectsRouter.post("/:id/roadmap/generate", jsonValidator(roadmapGenerateSchema), async (c) => {
  const { id } = c.req.param();
  const { roadmapAlias, vision } = c.req.valid("json");

  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  log.info({ projectId: id, roadmapAlias, hasVision: !!vision }, "Roadmap generation requested");

  // Fire-and-forget: run generation in background, broadcast result via WS
  runRoadmapGenerationJob(id, roadmapAlias, vision).catch((err) => {
    log.error({ projectId: id, roadmapAlias, err }, "Background roadmap generation crashed");
  });

  return c.json({ status: "started", projectId: id, roadmapAlias }, 202);
});

// POST /projects/:id/roadmap/import — trigger roadmap import and create backlog tasks
projectsRouter.post("/:id/roadmap/import", jsonValidator(roadmapImportSchema), async (c) => {
  const { id } = c.req.param();
  const { roadmapAlias } = c.req.valid("json");

  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  log.info({ projectId: id, roadmapAlias }, "Roadmap import requested");

  try {
    // Generate tasks from roadmap via Agent SDK
    const generation = await generateRoadmapTasks({
      projectId: id,
      roadmapAlias,
    });

    // Import with dedupe and tag enrichment
    const result = importGeneratedTasks(id, generation);

    // Broadcast each created task
    for (const taskId of result.taskIds) {
      const task = findTaskById(taskId);
      if (task) {
        broadcast({ type: "task:created", payload: toTaskBroadcastPayload(task) });
      }
    }

    // Wake coordinator to process new backlog items
    if (result.created > 0) {
      broadcast({ type: "agent:wake", payload: { id } });
      log.info(
        { projectId: id, roadmapAlias, created: result.created },
        "Batch wake event sent after roadmap import",
      );
    }

    log.info(
      { projectId: id, roadmapAlias, created: result.created, skipped: result.skipped },
      "Roadmap import completed",
    );

    return c.json(result, 201);
  } catch (err) {
    if (err instanceof RoadmapGenerationError) {
      const status =
        err.code === "PROJECT_NOT_FOUND" || err.code === "ROADMAP_NOT_FOUND" ? 404 : 500;
      log.warn(
        { projectId: id, roadmapAlias, code: err.code, error: err.message },
        "Roadmap import failed",
      );
      return c.json({ error: err.message, code: err.code }, status);
    }
    log.error({ projectId: id, roadmapAlias, err }, "Roadmap import unexpected error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// GET /projects/:id/auto-queue-mode
projectsRouter.get("/:id/auto-queue-mode", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const enabled = getAutoQueueMode(id);
  log.debug({ projectId: id, enabled }, "Read auto-queue-mode");
  return c.json({ enabled });
});

// PATCH /projects/:id/auto-queue-mode
projectsRouter.patch("/:id/auto-queue-mode", jsonValidator(autoQueueModeSchema), async (c) => {
  const { id } = c.req.param();
  const { enabled } = c.req.valid("json");
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  setAutoQueueMode(id, enabled);
  const updated = findProjectById(id);
  log.info({ projectId: id, enabled }, "Toggled auto-queue-mode");

  if (updated) {
    broadcast({ type: "project:auto_queue_mode_changed", payload: updated });
  }
  return c.json({ enabled });
});

// POST /projects/:id/broadcast — emit project-scoped WS event (used by agent coordinator)
projectsRouter.post(
  "/:id/broadcast",
  internalBroadcastAuth,
  jsonValidator(broadcastProjectSchema),
  async (c) => {
    const { id } = c.req.param();
    const { type, taskId, runtimeProfileId } = c.req.valid("json");
    const project = findProjectById(id);
    if (!project) return c.json({ error: "Project not found" }, 404);

    if (type === "project:auto_queue_advanced" && taskId) {
      const task = findTaskById(taskId);
      if (!task || task.projectId !== id) {
        return c.json({ error: "taskId does not belong to the target project" }, 400);
      }
    }

    if (type === "project:runtime_limit_updated" && !runtimeProfileId) {
      return c.json(
        { error: "runtimeProfileId is required for project:runtime_limit_updated" },
        400,
      );
    }

    if (type === "project:runtime_limit_updated" && runtimeProfileId) {
      const runtimeProfile = findRuntimeProfileById(runtimeProfileId);
      const belongsToProject =
        runtimeProfile?.projectId === id || runtimeProfile?.projectId == null;
      if (!runtimeProfile || !belongsToProject) {
        return c.json(
          { error: "runtimeProfileId must belong to the target project or be global" },
          400,
        );
      }
    }

    if (type === "project:auto_queue_advanced" && taskId) {
      broadcast({ type, payload: { id: taskId } });
    } else if (type === "project:runtime_limit_updated") {
      broadcast({
        type,
        payload: {
          projectId: id,
          runtimeProfileId: runtimeProfileId ?? null,
          taskId: taskId ?? null,
        },
      });
    } else {
      broadcast({ type, payload: project });
    }
    log.debug(
      { projectId: id, type, taskId: taskId ?? null, runtimeProfileId: runtimeProfileId ?? null },
      "Project WS broadcast triggered",
    );
    return c.json({ success: true });
  },
);

// DELETE /projects/:id
projectsRouter.delete("/:id", (c) => {
  const { id } = c.req.param();
  const existing = findProjectById(id);
  if (!existing) {
    return c.json({ error: "Project not found" }, 404);
  }

  deleteProject(id);
  log.debug({ projectId: id }, "Project deleted");
  return c.json({ success: true });
});

// -- Background roadmap generation job --

async function runRoadmapGenerationJob(
  projectId: string,
  roadmapAlias: string,
  vision?: string,
): Promise<void> {
  try {
    // Step 1: Generate ROADMAP.md
    const generated = await generateRoadmapFile({ projectId, vision });
    log.info({ projectId, roadmapPath: generated.roadmapPath }, "ROADMAP.md generated");

    // Step 2: Extract tasks from the generated roadmap
    const extraction = await generateRoadmapTasks({ projectId, roadmapAlias });

    // Step 3: Import with dedupe and tag enrichment
    const result = importGeneratedTasks(projectId, extraction);

    // Step 4: Broadcast each created task
    for (const taskId of result.taskIds) {
      const task = findTaskById(taskId);
      if (task) {
        broadcast({ type: "task:created", payload: toTaskBroadcastPayload(task) });
      }
    }

    // Wake coordinator
    if (result.created > 0) {
      broadcast({ type: "agent:wake", payload: { id: projectId } });
    }

    // Broadcast completion
    broadcast({
      type: "roadmap:complete",
      payload: {
        projectId,
        roadmapAlias: result.roadmapAlias,
        created: result.created,
        skipped: result.skipped,
        taskIds: result.taskIds,
        byPhase: result.byPhase,
      },
    });

    log.info(
      { projectId, roadmapAlias, created: result.created, skipped: result.skipped },
      "Roadmap generation and import completed",
    );
  } catch (err) {
    const code = err instanceof RoadmapGenerationError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    log.error({ projectId, roadmapAlias, code, error: message }, "Roadmap generation job failed");

    broadcast({
      type: "roadmap:error",
      payload: { projectId, roadmapAlias, error: message, code },
    });
  }
}
