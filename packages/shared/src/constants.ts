import type { TaskStatus } from "./types.js";

export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; order: number }> = {
  backlog: { label: "Backlog", color: "#6B7280", order: 0 },
  planning: { label: "Planning", color: "#F59E0B", order: 1 },
  plan_ready: { label: "Plan Ready", color: "#3B82F6", order: 2 },
  implementing: { label: "Implementing", color: "#8B5CF6", order: 3 },
  review: { label: "Review", color: "#EC4899", order: 4 },
  blocked_external: { label: "Blocked", color: "#EF4444", order: 5 },
  done: { label: "Done", color: "#10B981", order: 6 },
  verified: { label: "Verified", color: "#14B8A6", order: 7 },
};

export const ORDERED_STATUSES: TaskStatus[] = [
  "backlog",
  "planning",
  "plan_ready",
  "implementing",
  "review",
  "blocked_external",
  "done",
  "verified",
];
