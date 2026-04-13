import { describe, expect, it } from "vitest";
import type { Task } from "@aif/shared/browser";
import { calculateTaskMetrics } from "@/lib/taskMetrics";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(),
    projectId: "project-1",
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
    roadmapAlias: null,
    tags: [],
    status: "backlog",
    priority: 1,
    position: 1000,
    plan: null,
    implementationLog: null,
    reviewComments: null,
    agentActivityLog: null,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    manualReviewRequired: false,
    autoReviewState: null,
    paused: false,
    lastHeartbeatAt: null,
    lastSyncedAt: null,
    sessionId: null,
    scheduledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("calculateTaskMetrics", () => {
  it("aggregates completion, tokens and cost", () => {
    const tasks: Task[] = [
      makeTask({
        status: "done",
        tokenInput: 1000,
        tokenOutput: 300,
        tokenTotal: 1300,
        costUsd: 1.25,
      }),
      makeTask({
        status: "verified",
        tokenInput: 700,
        tokenOutput: 200,
        tokenTotal: 900,
        costUsd: 0.75,
        isFix: true,
      }),
      makeTask({
        status: "implementing",
        tokenInput: 500,
        tokenOutput: 100,
        tokenTotal: 600,
        costUsd: 0.5,
        retryCount: 2,
      }),
      makeTask({
        status: "blocked_external",
        tokenInput: 0,
        tokenOutput: 0,
        tokenTotal: 0,
        costUsd: 0,
        autoMode: false,
      }),
    ];

    const summary = calculateTaskMetrics(tasks);

    expect(summary.totalTasks).toBe(4);
    expect(summary.completedTasks).toBe(2);
    expect(summary.verifiedTasks).toBe(1);
    expect(summary.activeTasks).toBe(2);
    expect(summary.blockedTasks).toBe(1);
    expect(summary.totalTokenInput).toBe(2200);
    expect(summary.totalTokenOutput).toBe(600);
    expect(summary.totalTokenTotal).toBe(2800);
    expect(summary.totalCostUsd).toBe(2.5);
    expect(summary.averageTokensPerTask).toBe(700);
    expect(summary.averageCostPerTaskUsd).toBe(0.625);
    expect(summary.totalRetries).toBe(2);
    expect(summary.fixTasks).toBe(1);
    expect(summary.autoModeTasks).toBe(3);
    expect(summary.completionRate).toBe(50);
  });

  it("returns zero-safe defaults for empty input and invalid numeric values", () => {
    const summaryFromEmpty = calculateTaskMetrics([]);
    expect(summaryFromEmpty.totalTasks).toBe(0);
    expect(summaryFromEmpty.totalTokenTotal).toBe(0);
    expect(summaryFromEmpty.totalCostUsd).toBe(0);
    expect(summaryFromEmpty.completionRate).toBe(0);

    const summaryFromInvalidValues = calculateTaskMetrics([
      makeTask({
        status: "planning",
        tokenInput: Number.NaN,
        tokenOutput: Number.POSITIVE_INFINITY,
        tokenTotal: -10,
        costUsd: -1,
        retryCount: -5,
      }),
    ]);

    expect(summaryFromInvalidValues.totalTokenInput).toBe(0);
    expect(summaryFromInvalidValues.totalTokenOutput).toBe(0);
    expect(summaryFromInvalidValues.totalTokenTotal).toBe(0);
    expect(summaryFromInvalidValues.totalCostUsd).toBe(0);
    expect(summaryFromInvalidValues.totalRetries).toBe(0);
  });
});
