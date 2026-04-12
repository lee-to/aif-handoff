import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyHumanTaskEvent,
  looksLikeFullPlanUpdate,
  getProjectConfig,
  type TaskEvent,
} from "@aif/shared";
import {
  findProjectById,
  findTaskById,
  getLatestHumanComment,
  persistTaskPlanForTask,
  setTaskFields,
  type TaskRow,
} from "@aif/data";
import { runFastFixQuery, withTimeout } from "./fastFix.js";

interface EventHandlerInput {
  taskId: string;
  event: TaskEvent;
  deletePlanFile?: boolean;
}

export type EventHandlerResult =
  | { ok: false; status: number; error: string }
  | { ok: true; task: TaskRow; broadcastType: "task:moved" | "task:updated" };

async function handleFastFix(input: EventHandlerInput): Promise<EventHandlerResult> {
  const task = findTaskById(input.taskId);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  if (task.status !== "plan_ready") {
    return { ok: false, status: 409, error: "fast_fix is only allowed from plan_ready" };
  }
  if (task.autoMode) {
    return { ok: false, status: 409, error: "fast_fix is not needed when autoMode=true" };
  }

  const latestComment = getLatestHumanComment(task.id);
  if (!latestComment) {
    return {
      ok: false,
      status: 409,
      error: "fast_fix requires a human comment with requested fix",
    };
  }

  const project = findProjectById(task.projectId);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found for task" };
  }

  const previousPlan = task.plan?.trim() ?? "";
  if (!previousPlan) {
    return { ok: false, status: 409, error: "fast_fix requires an existing plan on the task" };
  }
  const cfg = getProjectConfig(project.rootPath);
  const effectivePlanPath = task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;

  let firstAttempt = "";
  try {
    firstAttempt = await withTimeout(
      runFastFixQuery({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        latestComment,
        projectRoot: project.rootPath,
        planPath: effectivePlanPath,
        previousPlan,
        shouldTryFileUpdate: true,
      }),
      90_000,
      "Fast fix query timed out",
    );
  } catch {
    // Fallback to no-tools mode below
  }

  const updatedPlan = looksLikeFullPlanUpdate(previousPlan, firstAttempt)
    ? firstAttempt
    : await withTimeout(
        runFastFixQuery({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          latestComment,
          projectRoot: project.rootPath,
          planPath: effectivePlanPath,
          previousPlan,
          priorAttempt: firstAttempt || undefined,
          shouldTryFileUpdate: false,
        }),
        90_000,
        "Fast fix query timed out",
      );

  if (!looksLikeFullPlanUpdate(previousPlan, updatedPlan)) {
    return {
      ok: false,
      status: 500,
      error: "Fast fix result omitted existing plan content. Plan was left unchanged.",
    };
  }

  const nowIso = new Date().toISOString();
  persistTaskPlanForTask({
    taskId: task.id,
    projectRoot: project.rootPath,
    isFix: task.isFix,
    planPath: task.planPath ?? undefined,
    planText: updatedPlan,
    updatedAt: nowIso,
  });

  setTaskFields(task.id, {
    reworkRequested: false,
    updatedAt: nowIso,
  });

  const updated = findTaskById(task.id);
  if (!updated) {
    return { ok: false, status: 404, error: "Task not found" };
  }

  return { ok: true, task: updated, broadcastType: "task:updated" };
}

function handleRegularTransition(input: EventHandlerInput): EventHandlerResult {
  const task = findTaskById(input.taskId);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  const { event } = input;
  const transition = applyHumanTaskEvent(task, event);
  if (!transition.ok) {
    return { ok: false, status: 409, error: transition.error };
  }

  if ((input.event === "approve_done" || input.event === "start_ai") && input.deletePlanFile) {
    const project = findProjectById(task.projectId);
    if (!project) {
      return { ok: false, status: 404, error: "Project not found for task" };
    }

    // For fix tasks, always remove canonical FIX_PLAN.md.
    // For regular tasks, use configured planPath (defaults from config.yaml).
    const cfg = getProjectConfig(project.rootPath);
    const planFilePath = task.isFix
      ? resolve(project.rootPath, cfg.paths.fix_plan)
      : resolve(project.rootPath, task.planPath || cfg.paths.plan);

    if (existsSync(planFilePath)) {
      unlinkSync(planFilePath);
    }
  }

  const nowIso = new Date().toISOString();
  setTaskFields(task.id, { ...transition.patch, lastHeartbeatAt: nowIso, updatedAt: nowIso });

  const updated = findTaskById(task.id);
  if (!updated) {
    return { ok: false, status: 404, error: "Task not found" };
  }

  return { ok: true, task: updated, broadcastType: "task:moved" };
}

function handleAcceptExistingPlan(input: EventHandlerInput): EventHandlerResult {
  const task = findTaskById(input.taskId);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  if (task.status !== "backlog") {
    return { ok: false, status: 409, error: "accept_existing_plan is only allowed from backlog" };
  }

  const project = findProjectById(task.projectId);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found for task" };
  }

  const cfg = getProjectConfig(project.rootPath);
  const planFilePath = task.isFix
    ? resolve(project.rootPath, cfg.paths.fix_plan)
    : resolve(project.rootPath, task.planPath || cfg.paths.plan);

  if (!existsSync(planFilePath)) {
    return { ok: false, status: 404, error: "Plan file not found on disk" };
  }

  const filePlan = readFileSync(planFilePath, "utf8");
  if (!filePlan.trim()) {
    return { ok: false, status: 409, error: "Plan file is empty" };
  }

  const nowIso = new Date().toISOString();
  persistTaskPlanForTask({
    taskId: input.taskId,
    planText: filePlan,
    projectRoot: project.rootPath,
    isFix: task.isFix,
    planPath: task.planPath ?? undefined,
    updatedAt: nowIso,
  });

  setTaskFields(input.taskId, {
    status: "plan_ready",
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    reworkRequested: false,
    reviewIterationCount: 0,
    manualReviewRequired: false,
    autoReviewState: null,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
  });

  const updated = findTaskById(input.taskId);
  if (!updated) {
    return { ok: false, status: 404, error: "Task not found after update" };
  }

  return { ok: true, task: updated, broadcastType: "task:moved" };
}

export async function handleTaskEvent(input: EventHandlerInput): Promise<EventHandlerResult> {
  if (input.event === "fast_fix") {
    return await handleFastFix(input);
  }
  if (input.event === "accept_existing_plan") {
    return handleAcceptExistingPlan(input);
  }
  return handleRegularTransition(input);
}
