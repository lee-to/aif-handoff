import { Hono, type Context } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { internalBroadcastAuth } from "../middleware/internalBroadcastAuth.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  logger,
  parseAttachments,
  getProjectConfig,
  defaultsForMode,
  getEnv,
  type TaskActionContext,
} from "@aif/shared";
import {
  createTaskSchema,
  updateTaskSchema,
  taskEventSchema,
  createTaskCommentSchema,
  reorderTaskSchema,
  broadcastTaskSchema,
  handoffTaskSchema,
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
  listTaskListItems,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listComments,
  createComment,
  updateComment,
  toTaskResponse,
  toTaskBroadcastPayload,
  toCommentResponse,
  getTaskPlanFileStatus,
  updateTaskPlan,
  syncTaskPlanFromFile,
} from "../repositories/tasks.js";
import {
  findProjectById,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  resolveEffectiveRuntimeProfilesForTasks,
  claimTask,
  releaseTaskClaim,
  updateTaskPositionOnly,
  tryStartQaRun,
  findParticipantById,
  getTaskOwnership,
  handoffTaskExecution,
  listTaskExecutorHistory,
  findGitHubIssueByTaskId,
  type TaskRow,
  type TaskOwnershipFilters,
} from "@aif/data";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("tasks-route");
const QA_LOCK_DURATION_MS = Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;

export const tasksRouter = new Hono<ParticipantApiEnv>();

const LEGACY_ACTION_CONTEXT: TaskActionContext = {
  participantsModeEnabled: false,
  actor: {
    kind: "anonymous",
    id: null,
    displayNameSnapshot: null,
  },
  participantRole: null,
  participantActive: true,
};

function requestActionContext(c: Context<ParticipantApiEnv>): TaskActionContext {
  if (!getEnv().PARTICIPANTS_MODE_ENABLED) return LEGACY_ACTION_CONTEXT;
  const auth = getParticipantAuth(c);
  const participant = auth?.session?.participant;
  if (!participant) {
    return {
      participantsModeEnabled: true,
      actor: {
        kind: "anonymous",
        id: null,
        displayNameSnapshot: null,
      },
      participantRole: null,
      participantActive: false,
    };
  }
  return {
    participantsModeEnabled: true,
    actor: {
      kind: "participant",
      id: participant.id,
      displayNameSnapshot: participant.displayName,
    },
    participantRole: participant.role,
    participantActive: participant.active,
  };
}

function canMutateTask(c: Context<ParticipantApiEnv>, taskId: string): boolean {
  const context = requestActionContext(c);
  if (!context.participantsModeEnabled || context.participantRole === "admin") return true;

  const actorId = context.actor.id;
  const assigned = Boolean(
    actorId &&
    getTaskOwnership(taskId)?.assignees.some(
      (assignee) => assignee.participantId === actorId && assignee.active,
    ),
  );
  const details = { taskId, actorId, method: c.req.method, path: c.req.path };
  if (assigned) {
    log.debug(details, "Authorized assigned participant task mutation");
  } else {
    log.warn(details, "Rejected unauthorized task mutation");
  }
  return assigned;
}

function parseTaskOwnershipFilters(
  c: Context<ParticipantApiEnv>,
  context: TaskActionContext,
): { ok: true; filters: TaskOwnershipFilters } | { ok: false; error: string } {
  const owner = c.req.query("owner") ?? c.req.query("executionOwner");
  if (owner !== undefined && owner !== "ai" && owner !== "human") {
    return { ok: false, error: "owner must be ai or human" };
  }
  const assignee = c.req.query("assigneeId");
  const unassignedRaw = c.req.query("unassigned");
  if (unassignedRaw !== undefined && unassignedRaw !== "true" && unassignedRaw !== "false") {
    return { ok: false, error: "unassigned must be true or false" };
  }
  const unassigned = unassignedRaw === "true";
  if (unassigned && assignee) {
    return { ok: false, error: "assigneeId and unassigned=true cannot be combined" };
  }
  const assigneeId =
    assignee === "me"
      ? context.actor.kind === "participant"
        ? (context.actor.id ?? undefined)
        : undefined
      : assignee;
  if (assignee === "me" && !assigneeId) {
    return { ok: false, error: "assigneeId=me requires an authenticated participant" };
  }
  return {
    ok: true,
    filters: {
      executionOwner: owner,
      assigneeId,
      unassigned,
    },
  };
}

/**
 * Fire-and-forget QA dispatch shared by the manual `run-qa` endpoint and the
 * auto-trigger on `approve_done`. The caller broadcasts `task:qa_started`
 * first; this helper GUARANTEES a terminating `task:qa_done` / `task:qa_failed`
 * even when the dynamic import or an unexpected throw escapes `runQaQuery`.
 * `runQaQuery` is contracted never to throw, but `import()` and `broadcast`
 * still can — without this outer guard a started run could hang the UI in
 * "running" forever (no terminal event, possible unhandled rejection).
 */
function dispatchQaRun(
  projectId: string,
  taskId: string,
  executionRoot: string,
  lockId: string,
): void {
  void (async () => {
    try {
      const { runQaQuery } = await import("../services/qaRunner.js");
      const result = await runQaQuery({ projectId, taskId, executionRoot });
      broadcast(
        result.ok
          ? { type: "task:qa_done", payload: { taskId, projectId, status: "done" } }
          : {
              type: "task:qa_failed",
              payload: { taskId, projectId, status: "failed", error: result.error },
            },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ taskId, projectId, error }, "QA dispatch failed before runner completed");
      // Release the claimed "running" slot with a terminal status: tryStartQaRun
      // only wins when qa_status != 'running', so without this a dispatch failure
      // would block every future QA start for the task. Defensive wrap — a DB
      // failure here must not prevent the task:qa_failed broadcast below.
      try {
        updateTask(taskId, { qaStatus: "error" });
        const failedTask = findTaskById(taskId);
        if (failedTask) {
          broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(failedTask) });
        }
      } catch (persistErr) {
        log.error(
          { persistErr, taskId },
          "Failed to persist QA error status after dispatch failure",
        );
      }
      broadcast({
        type: "task:qa_failed",
        payload: { taskId, projectId, status: "failed", error: message },
      });
    } finally {
      releaseTaskClaim(taskId, lockId);
    }
  })();
}

/**
 * Atomic QA start shared by the manual `run-qa` endpoint and the `approve_done`
 * auto-trigger. Claims the qaStatus:"running" slot via the DB-level
 * compare-and-set (`tryStartQaRun`), so concurrent manual + auto / double-POST
 * starts are mutually exclusive and never spawn two runtime runs. ONLY on a win
 * does it broadcast task:updated (running) + task:qa_started and dispatch the
 * fire-and-forget runner. Returns { started:false } when QA was already running
 * so the caller can respond 409 / skip. The status transition + the
 * task:qa_started broadcast happen here (synchronously), not deep inside the
 * async runner — that is what closes the check-then-set race.
 */
function startQaRun(
  projectId: string,
  taskId: string,
  executionRoot: string,
):
  | { started: true }
  | { started: false; code: "ai_handoff_required" | "task_locked" | "already_running" } {
  const task = findTaskById(taskId);
  if (task?.executionOwner !== "ai") {
    return { started: false, code: "ai_handoff_required" };
  }
  const lockId = `qa:${crypto.randomUUID()}`;
  if (!claimTask(taskId, lockId, QA_LOCK_DURATION_MS)) {
    const current = findTaskById(taskId);
    return {
      started: false,
      code: current?.executionOwner === "human" ? "ai_handoff_required" : "task_locked",
    };
  }
  if (!tryStartQaRun(taskId)) {
    releaseTaskClaim(taskId, lockId);
    return { started: false, code: "already_running" };
  }
  const runningTask = findTaskById(taskId);
  if (runningTask) {
    broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(runningTask) });
  }
  broadcast({ type: "task:qa_started", payload: { taskId, projectId, status: "started" } });
  dispatchQaRun(projectId, taskId, executionRoot, lockId);
  return { started: true };
}

function toTaskRouteResponse(
  task: TaskRow,
  systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task"),
  effectiveRuntime = resolveEffectiveRuntimeProfile({
    taskId: task.id,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  }),
  actionContext: TaskActionContext = LEGACY_ACTION_CONTEXT,
) {
  const response = toTaskResponse(task, actionContext);

  return {
    ...response,
    github: findGitHubIssueByTaskId(task.id) ?? null,
    effectiveRuntime: {
      source: effectiveRuntime.source,
      profileId: effectiveRuntime.profile?.id ?? null,
      runtimeId: effectiveRuntime.profile?.runtimeId ?? null,
      providerId: effectiveRuntime.profile?.providerId ?? null,
      profileName: effectiveRuntime.profile?.name ?? null,
    },
  };
}

// POST /tasks/:id/broadcast — emit WS update for a task (used by agent process)
tasksRouter.post(
  "/:id/broadcast",
  internalBroadcastAuth,
  jsonValidator(broadcastTaskSchema),
  async (c) => {
    const { id } = c.req.param();
    const { type } = c.req.valid("json");
    const task = findTaskById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    broadcast({ type, payload: toTaskBroadcastPayload(task) });
    log.debug({ taskId: id, type }, "Task WS broadcast triggered");
    return c.json({ success: true });
  },
);

// GET /tasks — list tasks.
//   • With projectId: lightweight TaskListItem[] (board/list rendering).
//   • Without projectId: full Task[] for ALL projects (legacy dashboard path,
//     retained until consumers migrate to GET /projects/overview — see cleanup PR).
//     The bare path maps rows through toTaskRouteResponse (same as GET /tasks/:id)
//     so the legacy response shape — parsed attachments/tags/runtimeOptions,
//     effectiveRuntime, normalized runtimeLimitSnapshot — is preserved exactly.
//     TODO(remove-bare-task-list): drop this branch once #141 lands.
tasksRouter.get("/", (c) => {
  const projectId = c.req.query("projectId") || undefined;
  const actionContext = requestActionContext(c);
  const ownershipFilters = parseTaskOwnershipFilters(c, actionContext);
  if (!ownershipFilters.ok) {
    return c.json({ error: ownershipFilters.error, code: "invalid_task_filter" }, 400);
  }

  // Legacy bare path: no projectId → return full Task[] across all projects.
  // Kept alive for merge-safety until dashboard consumers migrate to /overview.
  if (!projectId) {
    const allTasks = listTasks(undefined, ownershipFilters.filters);
    const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
    const effectiveRuntimeByTaskId = resolveEffectiveRuntimeProfilesForTasks(allTasks, {
      mode: "task",
      systemDefaultRuntimeProfileId,
    });
    log.debug({ count: allTasks.length, scope: "all" }, "Listed tasks (bare, legacy)");
    return c.json(
      allTasks.map((task) =>
        toTaskRouteResponse(
          task,
          systemDefaultRuntimeProfileId,
          effectiveRuntimeByTaskId.get(task.id),
          actionContext,
        ),
      ),
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    log.warn(
      { route: "GET /tasks", projectId },
      "Rejected task list request with invalid projectId",
    );
    return c.json({ error: "Invalid projectId format" }, 400);
  }

  const taskList = listTaskListItems(projectId, ownershipFilters.filters, actionContext);
  log.debug({ count: taskList.length, projectId, responseType: "TaskListItem" }, "Listed tasks");
  return c.json(taskList);
});

// POST /tasks — create
tasksRouter.post("/", jsonValidator(createTaskSchema), async (c) => {
  const body = c.req.valid("json");
  const actionContext = requestActionContext(c);
  const actor = actionContext.actor;
  if (
    actionContext.participantsModeEnabled &&
    actionContext.participantRole === "member" &&
    body.executionOwner === "human" &&
    (body.assigneeIds.length > 1 ||
      (body.assigneeIds.length === 1 && body.assigneeIds[0] !== actor.id))
  ) {
    return c.json(
      {
        error: "Members may create human tasks only unassigned or assigned to themselves",
        code: "forbidden",
      },
      403,
    );
  }
  if (body.executionOwner === "ai" && body.assigneeIds.length > 0) {
    return c.json(
      { error: "AI-owned tasks cannot have participant assignees", code: "invalid_ownership" },
      409,
    );
  }
  for (const participantId of body.assigneeIds) {
    const participant = findParticipantById(participantId);
    if (!participant?.active) {
      return c.json(
        { error: "One or more assignees are inactive or missing", code: "inactive_assignee" },
        409,
      );
    }
  }
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: body.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    log.warn(
      { projectId: body.projectId, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid task runtime selection",
    );
    return c.json(runtimeValidation, 400);
  }

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
  const resolvedRunPlanImprove = body.useSubagents ? false : body.runPlanImprove;
  const resolvedRunPostVerify = body.useSubagents ? false : body.runPostVerify;
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
    executionOwner: body.executionOwner,
    assigneeIds: body.assigneeIds,
    actor,
    isFix: body.isFix,
    plannerMode: body.plannerMode,
    planPath: body.planPath ?? defaultPlanPath,
    planDocs: resolvedPlanDocs,
    planTests: resolvedPlanTests,
    skipReview: resolvedSkipReview,
    useSubagents: body.useSubagents,
    runPlanImprove: resolvedRunPlanImprove,
    runPostVerify: resolvedRunPostVerify,
    autoQa: body.autoQa,
    maxReviewIterations: body.maxReviewIterations,
    paused: body.paused,
    runtimeProfileId: body.runtimeProfileId,
    modelOverride: body.modelOverride,
    runtimeOptions: body.runtimeOptions,
    roadmapAlias: body.roadmapAlias,
    tags: body.tags,
    scheduledAt: body.scheduledAt ?? null,
  });
  if (!created) {
    return c.json({ error: "Failed to create task ownership", code: "invalid_ownership" }, 409);
  }

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

  broadcast({
    type: "task:created",
    payload: toTaskBroadcastPayload(final, actor),
  });
  // Wake coordinator when a new task is created (may need immediate processing)
  if (final.executionOwner === "ai") {
    broadcast({ type: "agent:wake", payload: { id: final.id } });
  }
  return c.json(toTaskRouteResponse(final, undefined, undefined, actionContext), 201);
});

// POST /tasks/:id/handoff — atomically change execution owner and assignments
tasksRouter.post("/:id/handoff", jsonValidator(handoffTaskSchema), (c) => {
  const taskId = c.req.param("id");
  const body = c.req.valid("json");
  const task = findTaskById(taskId);
  if (!task) {
    return c.json({ error: "Task not found", code: "task_not_found" }, 404);
  }

  const actionContext = requestActionContext(c);
  const actorId = actionContext.actor.id;
  if (actionContext.participantsModeEnabled && actionContext.participantRole !== "admin") {
    const currentOwnership = getTaskOwnership(taskId);
    const assigned =
      actorId !== null &&
      Boolean(
        currentOwnership?.assignees.some(
          (assignee) => assignee.participantId === actorId && assignee.active,
        ),
      );
    const selfAssign =
      task.executionOwner === "human" &&
      (currentOwnership?.assignees.length ?? 0) === 0 &&
      body.executionOwner === "human" &&
      body.assigneeIds.length === 1 &&
      body.assigneeIds[0] === actorId;
    const assignedHumanToAi =
      task.executionOwner === "human" &&
      assigned &&
      body.executionOwner === "ai" &&
      body.assigneeIds.length === 0;
    if (!selfAssign && !assignedHumanToAi) {
      log.warn(
        {
          taskId,
          actorId,
          currentOwner: task.executionOwner,
          requestedOwner: body.executionOwner,
        },
        "Rejected unauthorized task handoff",
      );
      return c.json(
        { error: "Participant is not allowed to hand off this task", code: "forbidden" },
        403,
      );
    }
  }

  const result = handoffTaskExecution({
    taskId,
    executionOwner: body.executionOwner,
    assigneeIds: body.assigneeIds,
    expectedOwnershipRevision: body.expectedOwnershipRevision,
    expectedExecutionOwner: body.expectedExecutionOwner,
    expectedStatus: body.expectedStatus,
    actor: actionContext.actor,
    reason: body.reason,
    resumeAction: body.resumeAction,
  });
  if (!result.ok) {
    const code = {
      not_found: "task_not_found",
      locked: "task_locked",
      revision_conflict: "ownership_revision_conflict",
      inactive_assignee: "inactive_assignee",
      invalid_transition: "invalid_ownership_transition",
    }[result.code] as
      | "task_not_found"
      | "task_locked"
      | "ownership_revision_conflict"
      | "inactive_assignee"
      | "invalid_ownership_transition";
    const status = result.code === "not_found" ? 404 : 409;
    log.warn(
      {
        taskId,
        code,
        actorId,
        requestedOwner: body.executionOwner,
      },
      "Task handoff rejected",
    );
    return c.json(
      {
        error: "Task ownership handoff could not be applied",
        code,
        ...(result.ownership ? { ownership: result.ownership } : {}),
      },
      status,
    );
  }

  const updated = findTaskById(taskId);
  if (!updated) {
    return c.json({ error: "Task not found after handoff", code: "task_not_found" }, 404);
  }
  const ownershipPayload = {
    taskId,
    projectId: updated.projectId,
    ownership: result.ownership,
    actor: actionContext.actor,
    responsibleParticipants: result.ownership.assignees,
  };
  broadcast({ type: "task:handoff", payload: ownershipPayload });
  broadcast({ type: "task:assignment_updated", payload: ownershipPayload });
  if (
    result.ownership.executionOwner === "ai" &&
    updated.status !== "done" &&
    updated.status !== "verified"
  ) {
    broadcast({ type: "agent:wake", payload: { id: taskId } });
  }
  log.info(
    {
      taskId,
      actorId,
      executionOwner: result.ownership.executionOwner,
      ownershipRevision: result.ownership.ownershipRevision,
      assigneeCount: result.ownership.assignees.length,
    },
    "Task handoff completed",
  );
  return c.json({
    task: toTaskRouteResponse(updated, undefined, undefined, actionContext),
    ownership: result.ownership,
    history: result.history,
  });
});

tasksRouter.get("/:id/executor-history", (c) => {
  const taskId = c.req.param("id");
  if (!findTaskById(taskId)) {
    return c.json({ error: "Task not found", code: "task_not_found" }, 404);
  }
  return c.json(listTaskExecutorHistory(taskId));
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
  return c.json(toTaskRouteResponse(task, undefined, undefined, requestActionContext(c)));
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
  const actionContext = requestActionContext(c);
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Create comment first to get its DB-assigned ID
  const created = createComment({
    taskId: id,
    participantId: actionContext.actor.kind === "participant" ? actionContext.actor.id : null,
    message: body.message,
    attachments: [],
  });
  if (!created) return c.json({ error: "Failed to create comment" }, 500);

  // Persist attachments to project files using the real comment ID, then update
  let finalComment = created;
  if (body.attachments.length > 0) {
    const project = findProjectById(task.projectId);
    if (project) {
      const persisted = await persistAttachments(body.attachments, {
        projectRoot: project.rootPath,
        taskId: id,
        commentId: created.id,
      });
      const updated = updateComment(created.id, { attachments: persisted });
      finalComment = updated ?? created;
    }
  }

  const response = toCommentResponse(finalComment);
  broadcast({
    type: "task:comment_created",
    payload: {
      taskId: id,
      projectId: task.projectId,
      comment: response,
      actor: actionContext.actor,
      responsibleParticipants: response.participant ? [response.participant] : [],
    },
  });
  log.info(
    {
      taskId: id,
      commentId: response.id,
      participantId: response.participantId,
      attachmentCount: response.attachments.length,
    },
    "Task comment created",
  );
  return c.json(response, 201);
});

// PUT /tasks/:id — update fields
tasksRouter.put("/:id", jsonValidator(updateTaskSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }

  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    log.warn(
      { taskId: id, projectId: existing.projectId, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid task runtime selection",
    );
    return c.json(runtimeValidation, 400);
  }

  // Parallel-enabled projects enforce full mode
  const project = findProjectById(existing.projectId);
  if (project?.parallelEnabled) {
    if (body.plannerMode === "fast") {
      return c.json({ error: "Parallel-enabled projects require full planner mode" }, 400);
    }
  }

  const { plan, attachments: incomingAttachments, ...updatePayload } = body;
  const effectiveUseSubagents = updatePayload.useSubagents ?? existing.useSubagents;
  if (effectiveUseSubagents) {
    updatePayload.runPlanImprove = false;
    updatePayload.runPostVerify = false;
  }

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

  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
});

// POST /tasks/:id/sync-plan — sync DB plan with physical plan file
tasksRouter.post("/:id/sync-plan", (c) => {
  const { id } = c.req.param();
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task or project not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }
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

  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
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
  const actionContext = requestActionContext(c);
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  try {
    const handled = await handleTaskEvent({
      taskId: id,
      event,
      deletePlanFile,
      participantsModeEnabled: actionContext.participantsModeEnabled,
      actor: actionContext.actor,
      participantRole: actionContext.participantRole,
      participantActive: actionContext.participantActive,
    });
    if (!handled.ok) {
      return c.json(
        {
          error: handled.error,
          ...(handled.code ? { code: handled.code } : {}),
        },
        handled.status as ContentfulStatusCode,
      );
    }

    log.debug(
      { taskId: id, from: existing.status, to: handled.task.status, event },
      "Task state transition applied",
    );
    broadcast({
      type: handled.broadcastType,
      payload: toTaskBroadcastPayload(handled.task),
    });
    // Wake coordinator when task transitions may require agent processing
    if (handled.broadcastType === "task:moved") {
      broadcast({ type: "agent:wake", payload: { id: handled.task.id } });
    }

    // Fire-and-forget: run /aif-commit when approved with commit checkbox.
    // Broadcast lifecycle over WS so the UI can show a spinner/toast and the
    // approve modal does not close without feedback.
    if (event === "approve_done" && commitOnApprove) {
      const taskId = handled.task.id;
      const projectId = handled.task.projectId;
      log.info({ taskId, projectId }, "Approve-done commit flow started");
      broadcast({
        type: "task:commit_started",
        payload: { taskId, projectId, status: "started" },
      });
      void (async () => {
        const { runCommitQuery } = await import("../services/commitGeneration.js");
        const result = await runCommitQuery({ projectId, taskId });
        if (result.ok) {
          log.info({ taskId, projectId }, "Approve-done commit flow succeeded");
          broadcast({
            type: "task:commit_done",
            payload: { taskId, projectId, status: "done" },
          });
        } else {
          log.error({ taskId, projectId, error: result.error }, "Approve-done commit flow failed");
          broadcast({
            type: "task:commit_failed",
            payload: { taskId, projectId, status: "failed", error: result.error },
          });
        }
      })();
    }

    // Fire-and-forget: run /aif-qa when approved and autoQa is enabled on the task.
    // approve_done moves the task done -> verified; QA runs asynchronously after.
    // Gated behind AIF_QA_PIPELINE_ENABLED (off by default).
    if (event === "approve_done" && handled.task.autoQa && !getEnv().AIF_QA_PIPELINE_ENABLED) {
      log.debug(
        { taskId: handled.task.id },
        "Auto QA skipped — AIF_QA_PIPELINE_ENABLED is disabled",
      );
    } else if (event === "approve_done" && handled.task.autoQa) {
      // Branchless (fast-mode) tasks are allowed: the runner resolves the branch
      // via `git branch --show-current`, mirroring the aif-qa skill.
      const { id: taskId, projectId, worktreePath } = handled.task;
      const project = findProjectById(projectId);
      if (!project) {
        log.error({ taskId, projectId }, "Auto QA skipped — project not found");
      } else {
        const executionRoot = worktreePath ?? project.rootPath;
        log.info({ taskId }, "Auto QA triggered (autoQa=true)");
        const { started } = startQaRun(projectId, taskId, executionRoot);
        if (!started) {
          log.warn({ taskId }, "Auto QA skipped — QA already running");
        }
      }
    }

    return c.json(toTaskRouteResponse(handled.task, undefined, undefined, actionContext));
  } catch (error) {
    log.error({ taskId: id, event, error }, "Task event handling failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /tasks/:id/run-qa — manually trigger the aif-qa pipeline (fire-and-forget)
tasksRouter.post("/:id/run-qa", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }
  if (!getEnv().AIF_QA_PIPELINE_ENABLED) {
    log.warn({ taskId: id }, "QA cannot run — AIF_QA_PIPELINE_ENABLED is disabled");
    return c.json({ error: "QA pipeline is disabled", code: "feature_disabled" }, 403);
  }
  const project = findProjectById(task.projectId);
  if (!project) {
    log.error({ taskId: id, projectId: task.projectId }, "QA cannot run — project not found");
    return c.json({ error: "Project not found" }, 404);
  }

  const executionRoot = task.worktreePath ?? project.rootPath;
  log.info({ taskId: id, branchName: task.branchName }, "run-qa requested for task");
  // Atomic claim of the running slot — a second concurrent POST loses the
  // compare-and-set and gets 409 instead of starting a duplicate runtime run.
  const startResult = startQaRun(task.projectId, id, executionRoot);
  const { started } = startResult;
  if (!started) {
    if (startResult.code === "ai_handoff_required") {
      log.warn({ taskId: id }, "QA rejected for human-owned task");
      return c.json(
        {
          error: "The task must be handed to AI before QA can run",
          code: "ai_handoff_required",
        },
        409,
      );
    }
    log.warn({ taskId: id }, "QA already running for task, skipping");
    return c.json(
      {
        error:
          startResult.code === "task_locked"
            ? "Task is locked by another runtime operation"
            : "QA already running",
        code: startResult.code,
      },
      409,
    );
  }

  return c.json({ status: "accepted" }, 202);
});

// PATCH /tasks/:id/position — reorder within column
tasksRouter.patch("/:id/position", jsonValidator(reorderTaskSchema), async (c) => {
  const { id } = c.req.param();
  const { position } = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }

  updateTaskPositionOnly(id, position);
  const updated = findTaskById(id);
  if (!updated) return c.json({ error: "Task not found after reorder" }, 500);
  log.debug({ taskId: id, position }, "Task reordered");

  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
});
