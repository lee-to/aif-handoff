import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project, ProjectTaskOverview } from "@aif/shared/browser";
import { ProjectsOverview } from "@/components/project/ProjectsOverview";

// Regression test for the empty-project loading behavior.
//
// ProjectsOverview derives `isLoading` from the overview query state, so a
// project with zero tasks must render its card (0 / 0 badge) instead of
// hanging on skeleton cards forever.

const emptyProject: Project = {
  id: "proj-empty",
  name: "Empty Project",
  rootPath: "/tmp/empty",
  plannerMaxBudgetUsd: null,
  planCheckerMaxBudgetUsd: null,
  implementerMaxBudgetUsd: null,
  reviewSidecarMaxBudgetUsd: null,
  pinnedAt: null,
  groupName: null,
  autoQueueMode: false,
  parallelEnabled: false,
  defaultTaskRuntimeProfileId: null,
  defaultPlanRuntimeProfileId: null,
  defaultReviewRuntimeProfileId: null,
  defaultChatRuntimeProfileId: null,
  tokenInput: undefined,
  tokenOutput: undefined,
  tokenTotal: undefined,
  costUsd: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const emptyOverview: ProjectTaskOverview = {
  projectId: "proj-empty",
  lastActivityAt: null,
  totalTasks: 0,
  completedTasks: 0,
  verifiedTasks: 0,
  backlogTasks: 0,
  activeTasks: 0,
  blockedTasks: 0,
  autoModeTasks: 0,
  fixTasks: 0,
  totalRetries: 0,
  totalTokenInput: 0,
  totalTokenOutput: 0,
  totalTokenTotal: 0,
  totalCostUsd: 0,
  statusCounts: {
    backlog: 0,
    planning: 0,
    improve: 0,
    plan_ready: 0,
    implementing: 0,
    review: 0,
    verify: 0,
    blocked_external: 0,
    done: 0,
    verified: 0,
  },
  statusPreviews: {
    backlog: [],
    planning: [],
    improve: [],
    plan_ready: [],
    implementing: [],
    review: [],
    verify: [],
    blocked_external: [],
    done: [],
    verified: [],
  },
};

describe("ProjectsOverview empty-project loading regression", () => {
  it("does not stay in loading state when a project has zero tasks", () => {
    // Simulate the resolved state of useProjectTaskOverviews: the overview
    // query resolved successfully with a zero-task project (no loading).
    vi.mock("@/hooks/useProjects", () => ({
      useProjectTaskOverviews: () => ({
        data: [emptyOverview],
        isLoading: false,
      }),
    }));

    render(<ProjectsOverview projects={[emptyProject]} onSelectProject={() => {}} />);

    // The project card must render (not skeleton cards). The "0 / 0" badge
    // confirms the empty project resolved to a real, non-loading card.
    expect(screen.getByText("Empty Project")).toBeDefined();
    expect(screen.getByText("0 / 0")).toBeDefined();
    // No skeleton should be rendered.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
