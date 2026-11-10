import { z } from "zod";
import type { SwarmEvent, SwarmRun, SwarmSnapshot } from "@aif/shared";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const provider = z.object({ provider: z.enum(["claude", "codex"]), model: z.string().optional() });
const task = z.object({
  id,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(id),
  parentId: id.optional(),
  status: z.enum([
    "pending",
    "running",
    "submitted",
    "verifying",
    "integrated",
    "done",
    "blocked",
    "failed",
    "cancelled",
  ]),
  assignedAgentId: id.optional(),
  gitRef: z.string().optional(),
  integratedRef: z.string().optional(),
  report: z.string().optional(),
});
const agent = provider.extend({
  id,
  role: z.enum(["lead", "worker", "integration", "verifier"]),
  status: z.enum(["running", "idle", "stopped"]),
  heartbeatAt: count,
  currentTaskId: id.optional(),
  tokens: count,
  reservation: count,
});
export const runtimeRunSchema = z.object({
  schema_version: z.literal(1),
  id,
  project: z.string().min(1),
  goal: z.string(),
  status: z.enum(["running", "paused", "needs_attention", "completed", "failed", "cancelled"]),
  spec: z.object({
    acceptanceCriteria: z.array(z.string()),
    checks: z.array(z.array(z.string())),
    approval: z.enum(["manual", "integration", "restricted-actions"]),
    limits: z.object({ maxAgents: z.number().int().min(1).max(5), budgetTokens: count }),
  }),
  startedAt: count,
  finishedAt: count.optional(),
  sequence: count,
  tokens: count,
  tasks: z.array(task),
  agents: z.array(agent),
  artifacts: z.array(
    z.object({
      id,
      taskId: id.optional(),
      type: z.string(),
      git_ref: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
  approvals: z.array(
    z.object({
      id,
      taskId: id.optional(),
      gitRef: z.string(),
      kind: z.enum(["integration", "completion"]),
      status: z.enum(["pending", "approved", "rejected"]),
    }),
  ),
});
export const runtimeRunsSchema = z.object({
  schema_version: z.literal(1),
  runs: z.array(runtimeRunSchema),
});
export const runtimeEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: id,
  sequence: count,
  run_id: id,
  type: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  actor: id,
  payload: z.record(z.string(), z.unknown()),
});
export const runtimeEventsSchema = z.object({
  schema_version: z.literal(1),
  events: z.array(runtimeEventSchema),
});
export const runtimeDecisionSchema = z.object({
  schema_version: z.literal(1),
  ok: z.literal(true),
});
type RuntimeRun = z.infer<typeof runtimeRunSchema>;

export function normalizeSwarmRun(run: RuntimeRun, projectId: string): SwarmRun {
  return {
    id: run.id,
    project_id: projectId,
    goal: run.goal,
    acceptance_criteria: run.spec.acceptanceCriteria,
    status: run.status,
    created_at: new Date(run.startedAt).toISOString(),
    updated_at: null,
    started_at: new Date(run.startedAt).toISOString(),
    finished_at: run.finishedAt === undefined ? null : new Date(run.finishedAt).toISOString(),
    agent_limit: run.spec.limits.maxAgents,
    active_agents: run.agents.filter((entry) => entry.status === "running").length,
    token_total: run.tokens,
    cost_usd: null,
    budget_tokens: run.spec.limits.budgetTokens,
    completed_tasks: run.tasks.filter((entry) => entry.status === "done").length,
    total_tasks: run.tasks.length,
    policy: run.spec.approval,
    sandbox: "Runtime-managed Git worktrees",
    blockers: run.tasks
      .filter((entry) => entry.status === "blocked" || entry.status === "failed")
      .map((entry) => entry.report ?? entry.title),
    last_event: null,
  };
}

export function normalizeSwarmSnapshot(run: RuntimeRun, projectId: string): SwarmSnapshot {
  return {
    schema_version: 1,
    sequence: run.sequence,
    run: normalizeSwarmRun(run, projectId),
    tasks: run.tasks.map((entry) => ({
      id: entry.id,
      title: entry.title,
      parent_id: entry.parentId ?? null,
      depends_on: entry.dependsOn,
      status: entry.status,
      agent_id: entry.assignedAgentId ?? null,
      blocked_reason: ["blocked", "failed"].includes(entry.status) ? (entry.report ?? null) : null,
      result: entry.report ?? null,
      git_ref: entry.integratedRef ?? entry.gitRef ?? null,
      tests: [],
      duration_ms: null,
    })),
    agents: run.agents.map((entry) => ({
      id: entry.id,
      role: entry.role,
      provider: entry.provider,
      model: entry.model ?? "Default",
      task_id: entry.currentTaskId ?? null,
      heartbeat_at: new Date(entry.heartbeatAt).toISOString(),
      token_total: entry.tokens,
      status: entry.status,
      logs: [],
      task_history: run.tasks
        .filter((item) => item.assignedAgentId === entry.id)
        .map((item) => item.id),
    })),
    artifacts: run.artifacts.map((entry) => ({
      id: entry.id,
      task_id: entry.taskId ?? null,
      title: entry.type,
      git_ref: entry.git_ref,
      diff: null,
      tests: typeof entry.metadata.checks === "string" ? [entry.metadata.checks] : [],
      ci_status: null,
      status:
        entry.type === "integration-failure" || entry.metadata.accepted === false
          ? "failed"
          : entry.type === "integration"
            ? "integrated"
            : "verification",
      conflicts:
        entry.type === "integration-failure" && typeof entry.metadata.report === "string"
          ? [entry.metadata.report]
          : [],
      review: typeof entry.metadata.report === "string" ? entry.metadata.report : null,
    })),
    approvals: run.approvals.map((entry) => ({
      id: entry.id,
      run_id: run.id,
      artifact_id:
        run.artifacts.find((item) => item.git_ref === entry.gitRef && item.taskId === entry.taskId)
          ?.id ?? null,
      kind: entry.kind,
      summary: `${entry.kind}: ${entry.gitRef}`,
      status: entry.status,
    })),
  };
}

export function normalizeSwarmEvent(event: z.infer<typeof runtimeEventSchema>): SwarmEvent {
  const systemActor = [
    "owner",
    "operator",
    "viewer",
    "runtime",
    "lead",
    "worker",
    "integration",
    "verifier",
  ].includes(event.actor);
  const taskId = id.safeParse(event.payload.task_id ?? event.payload.taskId);
  const agentId = id.safeParse(event.payload.agent_id ?? (systemActor ? null : event.actor));
  return {
    ...event,
    actor: { id: systemActor ? null : event.actor, role: systemActor ? event.actor : "agent" },
    task_id: taskId.success ? taskId.data : null,
    agent_id: agentId.success ? agentId.data : null,
  };
}
