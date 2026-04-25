import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyHumanTaskEvent,
  assertCurrentBranch,
  ensureFeatureBranch,
  isBranchIsolationError,
  looksLikeFullPlanUpdate,
  getProjectConfig,
  restorePersistedBranch,
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

function restoreTaskBranchForMutation(
  task: TaskRow,
  projectRoot: string,
): EventHandlerResult | null {
  if (!task.branchName || task.isFix) return null;
  try {
    // task.branchName is a source-of-truth contract: every mutation path
    // (fast-fix, regular transition, accept_existing_plan) must land on the
    // persisted branch or fail loud. Use `restorePersistedBranch` instead of
    // `ensureFeatureBranch({switchOnly:true})` so config drift
    // (`git.enabled` / `create_branches` toggled off after planner) cannot
    // release us to current HEAD.
    restorePersistedBranch({
      projectRoot,
      taskId: task.id,
      persistedBranchName: task.branchName,
    });
    return null;
  } catch (err) {
    const error = isBranchIsolationError(err)
      ? `Branch isolation failure (${err.kind}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, status: 409, error };
  }
}

function assertTaskBranchPostRun(task: TaskRow, projectRoot: string): EventHandlerResult | null {
  if (!task.branchName || task.isFix) return null;
  try {
    assertCurrentBranch(projectRoot, task.branchName);
    return null;
  } catch (err) {
    const error = isBranchIsolationError(err)
      ? `Branch isolation failure (${err.kind}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, status: 409, error };
  }
}

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

  const branchError = restoreTaskBranchForMutation(task, project.rootPath);
  if (branchError) return branchError;

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

  // Post-run drift check: `runFastFixQuery` runs a runtime that may write to
  // disk (`@${planPath}` injection asks for file overwrite). A rogue skill
  // could `git checkout` mid-flow and persist plan/state on the wrong branch.
  const driftError = assertTaskBranchPostRun(task, project.rootPath);
  if (driftError) return driftError;

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

    const branchError = restoreTaskBranchForMutation(task, project.rootPath);
    if (branchError) return branchError;

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

  // Branch handling MUST happen before resolving/reading the plan file:
  // task.branchName is a source-of-truth contract, and an already-bound
  // task whose HEAD has drifted to a different branch would otherwise read
  // the plan file from the wrong work-tree state and persist that content
  // onto the bound branch. Two paths:
  //   - Already-bound (task.branchName set): restorePersistedBranch — config
  //     drift / missing branch / dirty tree fail loud, fail-closed.
  //   - Unbound (no task.branchName): ensureFeatureBranch creates the
  //     feature branch from base, then we read the plan from that branch.
  // Fix tasks keep the legacy no-branch behavior.
  let boundBranchName: string | null = task.branchName ?? null;
  if (!task.isFix && boundBranchName) {
    const branchError = restoreTaskBranchForMutation(task, project.rootPath);
    if (branchError) return branchError;
  } else if (!task.isFix && !boundBranchName) {
    try {
      const branchResult = ensureFeatureBranch({
        projectRoot: project.rootPath,
        taskId: task.id,
        title: task.title,
      });
      if (branchResult.action !== "skipped" && branchResult.branchName) {
        boundBranchName = branchResult.branchName;
      }
    } catch (err) {
      const error = isBranchIsolationError(err)
        ? `Branch isolation failure (${err.kind}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, status: 409, error };
    }
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
    branchName: boundBranchName,
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
