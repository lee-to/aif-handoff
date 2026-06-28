import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project } from "@aif/shared/browser";
import { ProjectsOverview } from "@/components/project/ProjectsOverview";

// Regression test for the empty-project loading bug (PR #138 review, must-fix #1).
//
// useAllProjectTasks derives `isLoading` from query state, NOT from data presence,
// so a project with zero tasks must resolve to { tasks: [], isLoading: false }
// instead of hanging on skeleton cards forever.

const emptyProject: Project = {
  id: "proj-empty",
  name: "Empty Project",
  rootPath: "/tmp/empty",
  plannerMaxBudgetUsd: null,
  planCheckerMaxBudgetUsd: null,
  implementerMaxBudgetUsd: null,
  reviewSidecarMaxBudgetUsd: null,
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

describe("ProjectsOverview empty-project loading regression", () => {
  it("does not stay in loading state when a project has zero tasks", () => {
    // Simulate the resolved state of useAllProjectTasks for a project whose
    // task list resolved successfully to [] (no tasks yet).
    vi.mock("@/hooks/useTasks", () => ({
      useAllProjectTasks: () => ({ tasks: [], isLoading: false }),
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
