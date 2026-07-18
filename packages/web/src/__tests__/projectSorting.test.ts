import { describe, expect, it } from "vitest";
import type { Project, ProjectTaskOverview, TaskStatus } from "@aif/shared/browser";
import { sortProjects } from "@/lib/projectSorting";

const statuses: TaskStatus[] = [
  "backlog",
  "planning",
  "improve",
  "plan_ready",
  "implementing",
  "review",
  "verify",
  "blocked_external",
  "done",
  "verified",
];

function project(id: string, name: string, pinnedAt: string | null = null): Project {
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    plannerMaxBudgetUsd: null,
    planCheckerMaxBudgetUsd: null,
    implementerMaxBudgetUsd: null,
    reviewSidecarMaxBudgetUsd: null,
    pinnedAt,
    groupName: null,
    parallelEnabled: false,
    autoQueueMode: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function overview(
  projectId: string,
  lastActivityAt: string | null,
  activeTasks: number,
): ProjectTaskOverview {
  return {
    projectId,
    lastActivityAt,
    totalTasks: activeTasks,
    completedTasks: 0,
    verifiedTasks: 0,
    backlogTasks: 0,
    activeTasks,
    blockedTasks: 0,
    autoModeTasks: 0,
    fixTasks: 0,
    totalRetries: 0,
    totalTokenInput: 0,
    totalTokenOutput: 0,
    totalTokenTotal: 0,
    totalCostUsd: 0,
    statusCounts: Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
      TaskStatus,
      number
    >,
    statusPreviews: Object.fromEntries(statuses.map((status) => [status, []])) as Record<
      TaskStatus,
      []
    >,
  };
}

describe("sortProjects", () => {
  const projects = [
    project("alpha", "Alpha"),
    project("beta", "Beta"),
    project("pinned", "Zulu", "2026-01-01T00:00:00.000Z"),
  ];
  const overviews = new Map([
    ["alpha", overview("alpha", "2026-01-03T00:00:00.000Z", 1)],
    ["beta", overview("beta", "2026-01-02T00:00:00.000Z", 5)],
    ["pinned", overview("pinned", "2025-01-01T00:00:00.000Z", 0)],
  ]);

  it("keeps pinned projects first and sorts by last activity", () => {
    expect(sortProjects(projects, "lastActivity", overviews).map(({ id }) => id)).toEqual([
      "pinned",
      "alpha",
      "beta",
    ]);
  });

  it("keeps pinned projects first and sorts by active task count", () => {
    expect(sortProjects(projects, "activeTasks", overviews).map(({ id }) => id)).toEqual([
      "pinned",
      "beta",
      "alpha",
    ]);
  });
});
