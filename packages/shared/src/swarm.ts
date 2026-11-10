import { z } from "zod";

export const SWARM_SCHEMA_VERSION = 1;
export const SWARM_RUN_STATUSES = [
  "draft",
  "queued",
  "running",
  "verifying",
  "paused",
  "needs_attention",
  "completed",
  "failed",
  "cancelled",
] as const;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();
const envelope = { schema_version: z.literal(SWARM_SCHEMA_VERSION) };

export const swarmRunSchema = z.object({
  id,
  project_id: id,
  goal: z.string(),
  acceptance_criteria: z.array(z.string()),
  status: z.enum(SWARM_RUN_STATUSES),
  created_at: timestamp,
  updated_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  worker_limit: count,
  active_workers: count,
  token_total: count,
  cost_usd: z.number().nonnegative().nullable(),
  budget_usd: z.number().positive().nullable(),
  completed_tasks: count,
  total_tasks: count,
  policy: z.enum(["manual", "integration", "restricted-actions"]),
  sandbox: z.string(),
  blockers: z.array(z.string()),
  last_event: z.object({ type: z.string(), timestamp, sequence: count }).nullable(),
});
export const swarmTaskSchema = z.object({
  id,
  parent_id: id.nullable(),
  depends_on: z.array(id),
  title: z.string(),
  status: z.string(),
  agent_id: id.nullable(),
  blocked_reason: z.string().nullable(),
  result: z.string().nullable(),
  git_ref: z.string().nullable(),
  tests: z.array(z.string()),
  duration_ms: count.nullable(),
});
export const swarmAgentSchema = z.object({
  id,
  role: z.string(),
  provider: z.string(),
  model: z.string(),
  task_id: id.nullable(),
  heartbeat_at: timestamp.nullable(),
  token_total: count,
  status: z.string(),
  logs: z.array(z.string()),
  task_history: z.array(id),
});
export const swarmArtifactSchema = z.object({
  id,
  task_id: id.nullable(),
  title: z.string(),
  git_ref: z.string().nullable(),
  diff: z.string().nullable(),
  tests: z.array(z.string()),
  ci_status: z.string().nullable(),
  status: z.string(),
  conflicts: z.array(z.string()),
  review: z.string().nullable(),
});
export const swarmApprovalSchema = z.object({
  id,
  run_id: id,
  artifact_id: id.nullable(),
  kind: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected", "changes_requested"]),
});
export const swarmEventSchema = z.object({
  ...envelope,
  event_id: id,
  sequence: count,
  run_id: id,
  type: z.string().min(1),
  timestamp,
  actor: z.object({ id: id.nullable(), role: z.string() }),
  task_id: id.nullable(),
  agent_id: id.nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export const swarmRunsSchema = z.object({ ...envelope, runs: z.array(swarmRunSchema) });
export const swarmSnapshotSchema = z.object({
  ...envelope,
  sequence: count,
  run: swarmRunSchema,
  tasks: z.array(swarmTaskSchema),
  agents: z.array(swarmAgentSchema),
  artifacts: z.array(swarmArtifactSchema),
  approvals: z.array(swarmApprovalSchema),
});
export const swarmEventsSchema = z.object({ ...envelope, events: z.array(swarmEventSchema) });
export const swarmCommandResultSchema = z.object({
  ...envelope,
  command_id: z.string().uuid(),
  run_id: id,
  accepted: z.literal(true),
});
export const createSwarmRunSchema = z
  .object({
    command_id: z.string().uuid(),
    goal: z.string().trim().min(1).max(10000),
    acceptance_criteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
    worker_limit: z.number().int().min(1).max(32),
    budget_usd: z.number().positive().max(100000).nullable(),
    policy: z.enum(["manual", "integration", "restricted-actions"]),
  })
  .strict();
export const swarmControlSchema = z
  .object({
    command_id: z.string().uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export const swarmDecisionSchema = swarmControlSchema
  .extend({
    decision: z.enum(["approve", "reject", "request_changes"]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const swarmInstructionSchema = swarmControlSchema
  .extend({
    instruction: z.string().trim().min(1).max(10000),
  })
  .strict();

export type SwarmRun = z.infer<typeof swarmRunSchema>;
export type SwarmSnapshot = z.infer<typeof swarmSnapshotSchema>;
export type SwarmEvent = z.infer<typeof swarmEventSchema>;
export type SwarmTask = z.infer<typeof swarmTaskSchema>;
export type SwarmAgent = z.infer<typeof swarmAgentSchema>;
export type SwarmArtifact = z.infer<typeof swarmArtifactSchema>;
export type CreateSwarmRunInput = z.infer<typeof createSwarmRunSchema>;
export type SwarmRole = "owner" | "operator" | "viewer";
export interface SwarmConnection {
  enabled: boolean;
  projectId: string | null;
  role: SwarmRole;
  schemaVersion: number;
}

export const SWARM_NOTIFICATION_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.needs_attention",
  "budget.exhausted",
  "task.blocked_long",
  "agent.repeated_failure",
  "approval.requested",
  "integration.failed",
]);
