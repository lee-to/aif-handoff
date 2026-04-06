import { describe, it, expect } from "vitest";
import type { Task } from "../types.js";
import { applyHumanTaskEvent } from "../stateMachine.js";

function makeTask(status: Task["status"]): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "Task",
    description: "",
    autoMode: true,
    isFix: false,
    plannerMode: "full",
    planPath: ".ai-factory/PLAN.md",
    planDocs: false,
    planTests: false,
    skipReview: false,
    useSubagents: true,
    status,
    priority: 0,
    position: 1000,
    plan: null,
    implementationLog: null,
    reviewComments: null,
    agentActivityLog: null,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    roadmapAlias: null,
    tags: [],
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    paused: false,
    lastHeartbeatAt: null,
    lastSyncedAt: null,
    runtimeProfileId: null,
    modelOverride: null,
    runtimeOptions: null,
    sessionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("task state machine", () => {
  it("allows start_ai from backlog", () => {
    const result = applyHumanTaskEvent(makeTask("backlog"), "start_ai");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("planning");
    }
  });

  it("rejects start_ai from non-backlog statuses", () => {
    const result = applyHumanTaskEvent(makeTask("done"), "start_ai");
    expect(result.ok).toBe(false);
  });

  it("allows accept_existing_plan from backlog", () => {
    const result = applyHumanTaskEvent(makeTask("backlog"), "accept_existing_plan");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("plan_ready");
    }
  });

  it("rejects accept_existing_plan from non-backlog statuses", () => {
    const result = applyHumanTaskEvent(makeTask("planning"), "accept_existing_plan");
    expect(result.ok).toBe(false);
  });

  it("allows approve_done from done", () => {
    const result = applyHumanTaskEvent(makeTask("done"), "approve_done");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("verified");
    }
  });

  it("allows request_changes from done", () => {
    const result = applyHumanTaskEvent(makeTask("done"), "request_changes");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("implementing");
      expect(result.patch.retryCount).toBe(0);
      expect(result.patch.reworkRequested).toBe(true);
    }
  });

  it("retries blocked task to previous status", () => {
    const blocked = {
      ...makeTask("blocked_external"),
      blockedFromStatus: "review" as const,
      blockedReason: "rate limit",
      retryAfter: new Date().toISOString(),
    };

    const result = applyHumanTaskEvent(blocked, "retry_from_blocked");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("review");
      expect(result.patch.blockedReason).toBeNull();
      expect(result.patch.blockedFromStatus).toBeNull();
      expect(result.patch.retryAfter).toBeNull();
    }
  });

  it("allows start_implementation from plan_ready when autoMode=false", () => {
    const result = applyHumanTaskEvent(
      { ...makeTask("plan_ready"), autoMode: false },
      "start_implementation",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("implementing");
    }
  });

  it("rejects start_implementation for autoMode=true", () => {
    const result = applyHumanTaskEvent(
      { ...makeTask("plan_ready"), autoMode: true },
      "start_implementation",
    );
    expect(result.ok).toBe(false);
  });

  it("allows request_replanning from plan_ready", () => {
    const result = applyHumanTaskEvent(
      { ...makeTask("plan_ready"), autoMode: false },
      "request_replanning",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("planning");
    }
  });

  it("rejects request_replanning outside plan_ready", () => {
    const result = applyHumanTaskEvent(makeTask("done"), "request_replanning");
    expect(result.ok).toBe(false);
  });

  it("allows fast_fix from plan_ready without changing status", () => {
    const result = applyHumanTaskEvent({ ...makeTask("plan_ready"), autoMode: false }, "fast_fix");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("plan_ready");
    }
  });

  it("rejects fast_fix outside plan_ready", () => {
    const result = applyHumanTaskEvent(makeTask("done"), "fast_fix");
    expect(result.ok).toBe(false);
  });

  it("rejects approve_done outside done", () => {
    const result = applyHumanTaskEvent(makeTask("planning"), "approve_done");
    expect(result.ok).toBe(false);
  });

  it("rejects request_changes outside done", () => {
    const result = applyHumanTaskEvent(makeTask("plan_ready"), "request_changes");
    expect(result.ok).toBe(false);
  });

  it("rejects retry_from_blocked outside blocked_external", () => {
    const result = applyHumanTaskEvent(makeTask("review"), "retry_from_blocked");
    expect(result.ok).toBe(false);
  });

  it("returns unknown event error for unsupported event", () => {
    const result = applyHumanTaskEvent(makeTask("backlog"), "unsupported" as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Unknown task event");
    }
  });
});
