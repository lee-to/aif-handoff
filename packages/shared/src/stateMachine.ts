import type { Task, TaskEvent, TaskStatus, UpdateTaskInput } from "./types.js";

type TransitionPatch = Pick<
  UpdateTaskInput,
  | "blockedReason"
  | "blockedFromStatus"
  | "retryAfter"
  | "retryCount"
  | "reworkRequested"
  | "reviewIterationCount"
  | "manualReviewRequired"
  | "autoReviewState"
> & { status: TaskStatus };

type TransitionResult = { ok: true; patch: TransitionPatch } | { ok: false; error: string };

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
} as const satisfies Omit<TransitionPatch, "status">;

export function applyHumanTaskEvent(
  task: Pick<Task, "status" | "autoMode" | "blockedFromStatus">,
  event: TaskEvent,
): TransitionResult {
  switch (event) {
    case "start_ai": {
      if (task.status !== "backlog") {
        return { ok: false, error: "start_ai is only allowed from backlog" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } };
    }
    case "accept_existing_plan": {
      if (task.status !== "backlog") {
        return { ok: false, error: "accept_existing_plan is only allowed from backlog" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_ready" } };
    }
    case "start_implementation": {
      if (task.status !== "plan_ready") {
        return { ok: false, error: "start_implementation is only allowed from plan_ready" };
      }
      if (task.autoMode) {
        return { ok: false, error: "start_implementation is not needed when autoMode=true" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } };
    }
    case "request_replanning": {
      if (task.status !== "plan_ready") {
        return { ok: false, error: "request_replanning is only allowed from plan_ready" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } };
    }
    case "fast_fix": {
      if (task.status !== "plan_ready") {
        return { ok: false, error: "fast_fix is only allowed from plan_ready" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_ready" } };
    }
    case "approve_done": {
      if (task.status !== "done") {
        return { ok: false, error: "approve_done is only allowed from done" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "verified" } };
    }
    case "request_changes": {
      if (task.status !== "done") {
        return { ok: false, error: "request_changes is only allowed from done" };
      }
      return {
        ok: true,
        patch: { ...CLEAN_STATE_RESET, status: "implementing", reworkRequested: true },
      };
    }
    case "retry_from_blocked": {
      if (task.status !== "blocked_external") {
        return { ok: false, error: "retry_from_blocked is only allowed from blocked_external" };
      }
      if (!task.blockedFromStatus) {
        return { ok: false, error: "blockedFromStatus is missing for retry_from_blocked" };
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: task.blockedFromStatus } };
    }
    default:
      return { ok: false, error: "Unknown task event" };
  }
}

export const HUMAN_ACTIONS_BY_STATUS: Record<TaskStatus, TaskEvent[]> = {
  backlog: ["start_ai"],
  planning: [],
  plan_ready: ["start_implementation", "request_replanning", "fast_fix"],
  implementing: [],
  review: [],
  blocked_external: ["retry_from_blocked"],
  done: ["approve_done", "request_changes"],
  verified: [],
};
