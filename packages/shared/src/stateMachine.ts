import type {
  AuditActor,
  ParticipantRole,
  Task,
  TaskEvent,
  TaskPermissions,
  TaskStatus,
  UpdateTaskInput,
} from "./types.js";

export type TransitionPatch = Pick<
  UpdateTaskInput,
  | "blockedReason"
  | "blockedFromStatus"
  | "retryAfter"
  | "retryCount"
  | "reworkRequested"
  | "reviewIterationCount"
  | "manualReviewRequired"
  | "autoReviewState"
  | "scheduledAt"
> & { status: TaskStatus };

export type TaskActionDeniedCode =
  | "action_not_allowed"
  | "actor_not_authorized"
  | "assignment_required"
  | "ai_handoff_required"
  | "blocked_status_missing";

export type TransitionResult =
  | { ok: true; patch: TransitionPatch }
  | { ok: false; code: TaskActionDeniedCode; error: string };

export interface TaskActionContext {
  participantsModeEnabled: boolean;
  actor: AuditActor;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
}

export type TaskPolicyView = Pick<
  Task,
  | "status"
  | "autoMode"
  | "executionOwner"
  | "assignees"
  | "blockedFromStatus"
  | "skipReview"
  | "runPostVerify"
>;

/** Default reset values applied when transitioning out of blocked/retry states. */
export const CLEAN_STATE_RESET = {
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  reworkRequested: false,
  reviewIterationCount: 0,
  manualReviewRequired: false,
  autoReviewState: null,
  scheduledAt: null,
} as const satisfies Omit<TransitionPatch, "status">;

function denied(code: TaskActionDeniedCode, error: string): TransitionResult {
  return { ok: false, code, error };
}

function resolveLegacyAction(
  task: Pick<TaskPolicyView, "status" | "autoMode" | "blockedFromStatus">,
  event: TaskEvent,
): TransitionResult {
  switch (event) {
    case "start_ai":
      return task.status === "backlog"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } }
        : denied("action_not_allowed", "start_ai is only allowed from backlog");
    case "accept_existing_plan":
      return task.status === "backlog"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_ready" } }
        : denied("action_not_allowed", "accept_existing_plan is only allowed from backlog");
    case "start_implementation":
      if (task.status !== "plan_ready") {
        return denied("action_not_allowed", "start_implementation is only allowed from plan_ready");
      }
      return task.autoMode
        ? denied("action_not_allowed", "start_implementation is not needed when autoMode=true")
        : { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } };
    case "request_replanning":
      return task.status === "plan_ready"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } }
        : denied("action_not_allowed", "request_replanning is only allowed from plan_ready");
    case "fast_fix":
      return task.status === "plan_ready"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_ready" } }
        : denied("action_not_allowed", "fast_fix is only allowed from plan_ready");
    case "approve_done":
      return task.status === "done"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "verified" } }
        : denied("action_not_allowed", "approve_done is only allowed from done");
    case "request_changes":
      return task.status === "done"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "request_changes is only allowed from done");
    case "retry_from_blocked":
      if (task.status !== "blocked_external") {
        return denied(
          "action_not_allowed",
          "retry_from_blocked is only allowed from blocked_external",
        );
      }
      return task.blockedFromStatus
        ? {
            ok: true,
            patch: { ...CLEAN_STATE_RESET, status: task.blockedFromStatus },
          }
        : denied("blocked_status_missing", "blockedFromStatus is missing for retry_from_blocked");
    default:
      return denied("action_not_allowed", "Unknown task event");
  }
}

function resolveHumanOwnerAction(task: TaskPolicyView, event: TaskEvent): TransitionResult {
  switch (event) {
    case "start_human_work":
      return task.status === "backlog"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } }
        : denied("action_not_allowed", "start_human_work is only allowed from backlog");
    case "mark_plan_ready":
      return task.status === "planning" || task.status === "improve"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_ready" } }
        : denied("action_not_allowed", "mark_plan_ready is only allowed from planning or improve");
    case "start_implementation":
      return task.status === "plan_ready"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } }
        : denied("action_not_allowed", "start_implementation is only allowed from plan_ready");
    case "submit_implementation": {
      if (task.status !== "implementing") {
        return denied(
          "action_not_allowed",
          "submit_implementation is only allowed from implementing",
        );
      }
      const status = task.runPostVerify ? "verify" : task.skipReview ? "done" : "review";
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status } };
    }
    case "complete_review":
      if (task.status !== "review") {
        return denied("action_not_allowed", "complete_review is only allowed from review");
      }
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: task.runPostVerify ? "verify" : "done",
        },
      };
    case "request_review_changes":
      return task.status === "review"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "request_review_changes is only allowed from review");
    case "pass_verification":
      if (task.status !== "verify") {
        return denied("action_not_allowed", "pass_verification is only allowed from verify");
      }
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: task.runPostVerify || task.skipReview ? "done" : "review",
        },
      };
    case "fail_verification":
      return task.status === "verify"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "fail_verification is only allowed from verify");
    case "approve_done":
    case "request_changes":
    case "retry_from_blocked":
      return resolveLegacyAction(task, event);
    case "start_ai":
    case "accept_existing_plan":
    case "request_replanning":
    case "fast_fix":
      return denied("ai_handoff_required", `${event} requires the task to be handed to AI`);
    default:
      return denied("action_not_allowed", "Unknown task event");
  }
}

function resolveParticipantAuthorization(
  task: TaskPolicyView,
  context: TaskActionContext,
): TransitionResult | null {
  if (!context.participantsModeEnabled) return null;
  if (
    context.actor.kind !== "participant" ||
    !context.actor.id ||
    context.participantActive === false ||
    !context.participantRole
  ) {
    return denied("actor_not_authorized", "An active participant is required");
  }
  if (context.participantRole === "admin") return null;
  if (task.executionOwner !== "human") {
    return denied("actor_not_authorized", "Members cannot act on AI-owned tasks");
  }
  const assigned = task.assignees.some(
    (assignee) => assignee.participantId === context.actor.id && assignee.active,
  );
  return assigned
    ? null
    : denied("assignment_required", "The participant must be assigned before acting on this task");
}

/**
 * Resolve a user-visible task action from immutable task and actor context.
 * This function performs no I/O so API, data, and UI response mappers share
 * exactly the same policy.
 */
export function resolveTaskAction(
  task: TaskPolicyView,
  event: TaskEvent,
  context: TaskActionContext,
): TransitionResult {
  const authorization = resolveParticipantAuthorization(task, context);
  if (authorization) return authorization;
  if (!context.participantsModeEnabled) {
    return resolveLegacyAction(task, event);
  }
  return task.executionOwner === "human"
    ? resolveHumanOwnerAction(task, event)
    : resolveLegacyAction(task, event);
}

/** Backward-compatible disabled-mode resolver used by existing callers. */
export function applyHumanTaskEvent(
  task: Pick<Task, "status" | "autoMode" | "blockedFromStatus">,
  event: TaskEvent,
): TransitionResult {
  return resolveLegacyAction(task, event);
}

export function resolveTaskPermissions(
  task: TaskPolicyView,
  context: TaskActionContext,
): TaskPermissions {
  const activeParticipant =
    context.actor.kind === "participant" &&
    Boolean(context.actor.id) &&
    context.participantActive !== false;
  const admin =
    context.participantsModeEnabled && activeParticipant && context.participantRole === "admin";
  const assigned =
    activeParticipant &&
    task.assignees.some(
      (assignee) => assignee.participantId === context.actor.id && assignee.active,
    );
  const humanUnassigned = task.executionOwner === "human" && task.assignees.length === 0;
  const permittedActions = (Object.keys(TASK_ACTION_LOOKUP) as TaskEvent[]).filter(
    (event) => resolveTaskAction(task, event, context).ok,
  );

  if (!context.participantsModeEnabled) {
    return {
      canAssign: true,
      canHandoff: true,
      canSelfAssign: false,
      canAct: permittedActions.length > 0,
      canComment: true,
      permittedActions,
    };
  }

  return {
    canAssign: admin,
    canHandoff: admin || (task.executionOwner === "human" && assigned),
    canSelfAssign: activeParticipant && context.participantRole === "member" && humanUnassigned,
    canAct: permittedActions.length > 0,
    canComment: activeParticipant,
    permittedActions,
  };
}

const TASK_ACTION_LOOKUP: Record<TaskEvent, true> = {
  start_ai: true,
  accept_existing_plan: true,
  start_human_work: true,
  mark_plan_ready: true,
  start_implementation: true,
  submit_implementation: true,
  complete_review: true,
  request_review_changes: true,
  pass_verification: true,
  fail_verification: true,
  request_replanning: true,
  fast_fix: true,
  approve_done: true,
  request_changes: true,
  retry_from_blocked: true,
};

/** Legacy status-only actions; owner-aware UI permissions come from resolveTaskPermissions(). */
export const HUMAN_ACTIONS_BY_STATUS: Record<TaskStatus, TaskEvent[]> = {
  backlog: ["start_ai"],
  planning: [],
  improve: [],
  plan_ready: ["start_implementation", "request_replanning", "fast_fix"],
  implementing: [],
  review: [],
  verify: [],
  blocked_external: ["retry_from_blocked"],
  done: ["approve_done", "request_changes"],
  verified: [],
};
