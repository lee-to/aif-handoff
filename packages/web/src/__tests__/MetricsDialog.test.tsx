import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Project } from "@aif/shared/browser";
import { MetricsDialog } from "@/components/layout/MetricsDialog";
import type { TaskMetricsSummary } from "@/lib/taskMetrics";

const zeroMetrics: TaskMetricsSummary = {
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
  averageTokensPerTask: 0,
  totalCostUsd: 0,
  averageCostPerTaskUsd: 0,
  completionRate: 0,
};

function makeMetrics(overrides: Partial<TaskMetricsSummary> = {}): TaskMetricsSummary {
  return { ...zeroMetrics, ...overrides };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Project 1",
    rootPath: "/tmp/p1",
    plannerMaxBudgetUsd: null,
    planCheckerMaxBudgetUsd: null,
    implementerMaxBudgetUsd: null,
    reviewSidecarMaxBudgetUsd: null,
    parallelEnabled: false,
    autoQueueMode: false,
    createdAt: "2026-04-16T00:00:00Z",
    updatedAt: "2026-04-16T00:00:00Z",
    ...overrides,
  };
}

function cardFor(labelText: string): HTMLElement {
  return screen.getByText(labelText).parentElement as HTMLElement;
}

describe("MetricsDialog", () => {
  it("shows project totals when a project is selected", () => {
    const project = makeProject({
      tokenInput: 1000,
      tokenOutput: 2000,
      tokenTotal: 3000,
      costUsd: 1.5,
    });
    const taskMetrics = makeMetrics({ totalTokenTotal: 500, totalCostUsd: 0.25, totalTasks: 2 });

    render(
      <MetricsDialog open onOpenChange={vi.fn()} taskMetrics={taskMetrics} project={project} />,
    );

    expect(screen.getByText("Metrics")).toBeInTheDocument();
    const tokenCard = cardFor("Total token usage");
    expect(within(tokenCard).getByText("3,000")).toBeInTheDocument();
    expect(within(tokenCard).getByText("in 1,000 / out 2,000")).toBeInTheDocument();
    const costCard = cardFor("Total cost");
    expect(within(costCard).getByText("$1.50")).toBeInTheDocument();
    expect(within(costCard).getByText("tasks: $0.25")).toBeInTheDocument();
  });

  it("renders aggregate totals and 'all projects' title when no project selected", () => {
    const taskMetrics = makeMetrics({
      totalTasks: 5,
      totalTokenInput: 100,
      totalTokenOutput: 200,
      totalTokenTotal: 300,
      totalCostUsd: 0.1,
    });

    render(
      <MetricsDialog
        open
        onOpenChange={vi.fn()}
        taskMetrics={taskMetrics}
        project={null}
        aggregateTotals={{
          tokenInput: 5000,
          tokenOutput: 7000,
          tokenTotal: 12000,
          costUsd: 4.75,
        }}
      />,
    );

    expect(screen.getByText("Metrics — all projects")).toBeInTheDocument();
    const tokenCard = cardFor("Total token usage");
    expect(within(tokenCard).getByText("12,000")).toBeInTheDocument();
    expect(within(tokenCard).getByText("in 5,000 / out 7,000")).toBeInTheDocument();
    const costCard = cardFor("Total cost");
    expect(within(costCard).getByText("$4.75")).toBeInTheDocument();
    expect(within(costCard).getByText("tasks: $0.10")).toBeInTheDocument();
  });

  it("falls back to taskMetrics totals when no project and no aggregate provided", () => {
    const taskMetrics = makeMetrics({
      totalTokenInput: 11,
      totalTokenOutput: 22,
      totalTokenTotal: 33,
      totalCostUsd: 0.77,
    });

    render(<MetricsDialog open onOpenChange={vi.fn()} taskMetrics={taskMetrics} project={null} />);

    expect(screen.getByText("Metrics")).toBeInTheDocument();
    const tokenCard = cardFor("Total token usage");
    expect(within(tokenCard).getByText("33")).toBeInTheDocument();
    expect(within(tokenCard).getByText("in 11 / out 22")).toBeInTheDocument();
    const costCard = cardFor("Total cost");
    expect(within(costCard).getByText("$0.77")).toBeInTheDocument();
  });
});
