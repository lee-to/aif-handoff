import { describe, it, expect } from "vitest";
import type { Task } from "../types.js";
import { applyHumanTaskEvent, resolveTaskAction, resolveTaskPermissions } from "../stateMachine.js";

function makeTask(status: Task["status"]): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    title: "Task",
    description: "",
    autoMode: true,
    executionOwner: "ai",
    ownershipRevision: 0,
    assignees: [],
    isFix: false,
    plannerMode: "full",
    planPath: ".ai-factory/PLAN.md",
    planDocs: false,
    planTests: false,
    skipReview: false,
    useSubagents: true,
    runPlanImprove: false,
    runPostVerify: false,
    autoQa: false,
    qaChangeSummary: null,
    qaTestPlan: null,
    qaTestCases: null,
    qaStatus: "idle",
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
    manualReviewRequired: false,
    autoReviewState: null,
    paused: false,
    lastHeartbeatAt: null,
    lastSyncedAt: null,
    runtimeProfileId: null,
    modelOverride: null,
    runtimeOptions: null,
    sessionId: null,
    scheduledAt: null,
    branchName: null,
    worktreePath: null,
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

  it("keeps improve and verify as coordinator-only statuses", () => {
    expect(applyHumanTaskEvent(makeTask("improve"), "start_implementation").ok).toBe(false);
    expect(applyHumanTaskEvent(makeTask("verify"), "approve_done").ok).toBe(false);
  });

  it("allows accept_existing_plan from backlog", () => {
    const result = applyHumanTaskEvent(makeTask("backlog"), "accept_existing_plan");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("plan_ready");
      expect(result.patch.reviewIterationCount).toBe(0);
      expect(result.patch.manualReviewRequired).toBe(false);
      expect(result.patch.autoReviewState).toBeNull();
    }
  });

  it("rejects accept_existing_plan from non-backlog statuses", () => {
    const result = applyHumanTaskEvent(makeTask("planning"), "accept_existing_plan");
    expect(result.ok).toBe(false);
  });

  it("allows approve_done from done", () => {
    const task = makeTask("done");
    task.reviewIterationCount = 2;
    task.manualReviewRequired = true;
    task.autoReviewState = {
      strategy: "closure_first",
      iteration: 2,
      findings: [{ id: "finding-1", source: "code_review", text: "Manual review needed" }],
    };

    const result = applyHumanTaskEvent(task, "approve_done");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("verified");
      expect(result.patch.reviewIterationCount).toBe(0);
      expect(result.patch.manualReviewRequired).toBe(false);
      expect(result.patch.autoReviewState).toBeNull();
    }
  });

  it("allows request_changes from done", () => {
    const task = makeTask("done");
    task.reviewIterationCount = 3;
    task.manualReviewRequired = true;
    task.autoReviewState = {
      strategy: "closure_first",
      iteration: 3,
      findings: [{ id: "finding-2", source: "review_gate", text: "Retry review loop" }],
    };

    const result = applyHumanTaskEvent(task, "request_changes");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.status).toBe("implementing");
      expect(result.patch.retryCount).toBe(0);
      expect(result.patch.reworkRequested).toBe(true);
      expect(result.patch.reviewIterationCount).toBe(0);
      expect(result.patch.manualReviewRequired).toBe(false);
      expect(result.patch.autoReviewState).toBeNull();
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

  it.each([
    ["backlog", "start_human_work", "planning"],
    ["planning", "mark_plan_ready", "plan_ready"],
    ["improve", "mark_plan_ready", "plan_ready"],
    ["plan_ready", "start_implementation", "implementing"],
    ["review", "request_review_changes", "implementing"],
    ["verify", "fail_verification", "implementing"],
    ["done", "approve_done", "verified"],
    ["done", "request_changes", "implementing"],
  ] as const)("resolves assigned human action %s -> %s -> %s", (status, event, expectedStatus) => {
    const task = {
      ...makeTask(status),
      executionOwner: "human" as const,
      assignees: [
        {
          participantId: "member-1",
          displayName: "Member",
          role: "member" as const,
          active: true,
        },
      ],
    };
    const result = resolveTaskAction(task, event, {
      participantsModeEnabled: true,
      actor: {
        kind: "participant",
        id: "member-1",
        displayNameSnapshot: "Member",
      },
      participantRole: "member",
      participantActive: true,
    });
    expect(result).toMatchObject({ ok: true, patch: { status: expectedStatus } });
  });

  it.each([
    [{ skipReview: false, runPostVerify: false }, "review"],
    [{ skipReview: true, runPostVerify: false }, "done"],
    [{ skipReview: false, runPostVerify: true }, "verify"],
  ] as const)("routes submitted implementation using review/verify policy", (flags, status) => {
    const result = resolveTaskAction(
      {
        ...makeTask("implementing"),
        ...flags,
        executionOwner: "human",
        assignees: [],
      },
      "submit_implementation",
      {
        participantsModeEnabled: true,
        actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
        participantRole: "admin",
      },
    );
    expect(result).toMatchObject({ ok: true, patch: { status } });
  });

  it.each([
    [{ skipReview: false, runPostVerify: false }, "review"],
    [{ skipReview: true, runPostVerify: false }, "done"],
    [{ skipReview: false, runPostVerify: true }, "done"],
  ] as const)("routes passed verification using review/verify policy", (flags, status) => {
    const result = resolveTaskAction(
      {
        ...makeTask("verify"),
        ...flags,
        executionOwner: "human",
        assignees: [],
      },
      "pass_verification",
      {
        participantsModeEnabled: true,
        actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
        participantRole: "admin",
      },
    );
    expect(result).toMatchObject({ ok: true, patch: { status } });
  });

  it("requires member assignment but lets an admin act on any human task", () => {
    const task = {
      ...makeTask("planning"),
      executionOwner: "human" as const,
      assignees: [],
    };
    expect(
      resolveTaskAction(task, "mark_plan_ready", {
        participantsModeEnabled: true,
        actor: { kind: "participant", id: "member-1", displayNameSnapshot: "Member" },
        participantRole: "member",
      }),
    ).toMatchObject({ ok: false, code: "assignment_required" });
    expect(
      resolveTaskAction(task, "mark_plan_ready", {
        participantsModeEnabled: true,
        actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
        participantRole: "admin",
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps AI-only actions behind an AI handoff for human-owned tasks", () => {
    const result = resolveTaskAction(
      {
        ...makeTask("backlog"),
        executionOwner: "human",
        assignees: [],
      },
      "start_ai",
      {
        participantsModeEnabled: true,
        actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
        participantRole: "admin",
      },
    );
    expect(result).toMatchObject({ ok: false, code: "ai_handoff_required" });
  });

  it("derives role-aware permissions without duplicating transition rules", () => {
    const task = {
      ...makeTask("backlog"),
      executionOwner: "human" as const,
      assignees: [],
    };
    const memberPermissions = resolveTaskPermissions(task, {
      participantsModeEnabled: true,
      actor: { kind: "participant", id: "member-1", displayNameSnapshot: "Member" },
      participantRole: "member",
    });
    expect(memberPermissions).toMatchObject({
      canAssign: false,
      canHandoff: false,
      canSelfAssign: true,
      canAct: false,
      canComment: true,
      permittedActions: [],
    });

    const adminPermissions = resolveTaskPermissions(task, {
      participantsModeEnabled: true,
      actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
      participantRole: "admin",
    });
    expect(adminPermissions.canAssign).toBe(true);
    expect(adminPermissions.canHandoff).toBe(true);
    expect(adminPermissions.permittedActions).toContain("start_human_work");
  });

  it("preserves disabled-mode anonymous compatibility", () => {
    const task = {
      ...makeTask("backlog"),
      executionOwner: "human" as const,
      assignees: [],
    };
    expect(
      resolveTaskAction(task, "start_ai", {
        participantsModeEnabled: false,
        actor: { kind: "anonymous", id: null, displayNameSnapshot: null },
      }),
    ).toMatchObject({ ok: true, patch: { status: "planning" } });
  });
});
