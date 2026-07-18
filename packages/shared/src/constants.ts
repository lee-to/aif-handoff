import type { TaskStatus } from "./types.js";

export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; order: number }> = {
  backlog: { label: "Backlog", color: "#6B7280", order: 0 },
  planning: { label: "Planning", color: "#F59E0B", order: 1 },
  improve: { label: "Improve", color: "#D97706", order: 2 },
  plan_ready: { label: "Plan Ready", color: "#3B82F6", order: 3 },
  implementing: { label: "Implementing", color: "#8B5CF6", order: 4 },
  verify: { label: "Verify", color: "#0EA5E9", order: 5 },
  review: { label: "Review", color: "#EC4899", order: 6 },
  blocked_external: { label: "Blocked", color: "#EF4444", order: 7 },
  done: { label: "Done", color: "#10B981", order: 8 },
  verified: { label: "Verified", color: "#14B8A6", order: 9 },
};

export const ORDERED_STATUSES: TaskStatus[] = [
  "backlog",
  "planning",
  "improve",
  "plan_ready",
  "implementing",
  "verify",
  "review",
  "blocked_external",
  "done",
  "verified",
];

export const WARMUP_TARGETS = [
  { workflowKind: "planner", profileMode: "plan" },
  { workflowKind: "implementer", profileMode: "task" },
  { workflowKind: "reviewer", profileMode: "review" },
] as const;

export const WARMUP_WORKFLOW_KINDS = [
  "planner",
  "implementer",
  "reviewer",
  // Security review uses the review profile/mode and can fork the reviewer warmup seed.
  "review-security",
] as const;

export type WarmupTarget = (typeof WARMUP_TARGETS)[number];
export type WarmupWorkflowKind = (typeof WARMUP_WORKFLOW_KINDS)[number];
export type WarmupProfileMode = WarmupTarget["profileMode"];

export const DEFAULT_WARMUP_TARGET = WARMUP_TARGETS[0];

export function isWarmupWorkflowKind(
  workflowKind: string | null | undefined,
): workflowKind is WarmupWorkflowKind {
  return WARMUP_WORKFLOW_KINDS.some((kind) => kind === workflowKind);
}
