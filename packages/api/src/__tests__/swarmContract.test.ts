import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { swarmSnapshotSchema } from "@aif/shared";
import {
  normalizeSwarmEvent,
  normalizeSwarmSnapshot,
  runtimeEventSchema,
  runtimeRunSchema,
} from "../services/swarmContract.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../docs/swarm-runtime-v1.snapshot.json", import.meta.url), "utf8"),
);
describe("native Swarm Runtime v1 normalization", () => {
  it("preserves reported evidence and leaves unavailable data unknown", () => {
    const run = runtimeRunSchema.parse(fixture);
    const result = swarmSnapshotSchema.parse(normalizeSwarmSnapshot(run, "project-1"));
    expect(result.run).toMatchObject({
      project_id: "project-1",
      agent_limit: 5,
      active_agents: 0,
      budget_tokens: 1000000,
      cost_usd: null,
      updated_at: null,
      last_event: null,
    });
    expect(result.tasks[0]).toMatchObject({
      result: "Updated links",
      git_ref: "worker-commit",
      tests: [],
      duration_ms: null,
    });
    expect(result.agents[0]).toMatchObject({
      model: "Default",
      logs: [],
      task_history: ["task-1"],
    });
    expect(result.artifacts[0]).toMatchObject({
      status: "integrated",
      tests: ["pass"],
      diff: null,
      ci_status: null,
      review: "Checks passed",
    });
    expect(result.approvals[0]).toMatchObject({ run_id: "run-1", artifact_id: "artifact-1" });
    expect(result).not.toHaveProperty("context");
    expect(result).not.toHaveProperty("messages");
  });
  it("handles absent refs, blocked tasks, active agents and failed verification", () => {
    const input = structuredClone(fixture);
    input.tasks = [
      {
        ...input.tasks[0],
        status: "blocked",
        report: undefined,
        gitRef: undefined,
        assignedAgentId: undefined,
        parentId: "parent-1",
      },
    ];
    input.agents[0] = {
      ...input.agents[0],
      status: "running",
      currentTaskId: "task-1",
      model: "model-1",
    };
    input.artifacts = [
      {
        id: "artifact-2",
        type: "integration-failure",
        git_ref: "failed-ref",
        metadata: { report: "Conflict" },
      },
      { id: "artifact-3", type: "verification", git_ref: "ref", metadata: { accepted: false } },
    ];
    input.finishedAt = input.startedAt + 1000;
    const result = normalizeSwarmSnapshot(runtimeRunSchema.parse(input), "project-1");
    expect(result.run.active_agents).toBe(1);
    expect(result.run.blockers).toEqual(["Check documentation"]);
    expect(result.tasks[0]).toMatchObject({
      parent_id: "parent-1",
      result: null,
      git_ref: null,
      blocked_reason: null,
      agent_id: null,
    });
    expect(result.artifacts[0]).toMatchObject({ status: "failed", conflicts: ["Conflict"] });
    expect(result.artifacts[1]).toMatchObject({ status: "failed", review: null });
    expect(result.approvals[0].artifact_id).toBeNull();
  });
  it("extracts native actor and payload references without trusting arbitrary ID values", () => {
    const base = {
      schema_version: 1,
      event_id: "event-1",
      sequence: 1,
      run_id: "run-1",
      type: "task.submitted",
      timestamp: "2026-11-10T09:00:00Z",
    };
    expect(
      normalizeSwarmEvent(
        runtimeEventSchema.parse({ ...base, actor: "worker-1", payload: { task_id: "task-1" } }),
      ),
    ).toMatchObject({
      actor: { id: "worker-1", role: "agent" },
      task_id: "task-1",
      agent_id: "worker-1",
    });
    expect(
      normalizeSwarmEvent(
        runtimeEventSchema.parse({
          ...base,
          actor: "integration",
          payload: { taskId: "task-2", agent_id: "worker-2" },
        }),
      ),
    ).toMatchObject({
      actor: { id: null, role: "integration" },
      task_id: "task-2",
      agent_id: "worker-2",
    });
    expect(
      normalizeSwarmEvent(
        runtimeEventSchema.parse({
          ...base,
          actor: "owner",
          payload: { task_id: { unexpected: true } },
        }),
      ),
    ).toMatchObject({ task_id: null, agent_id: null });
  });
});
