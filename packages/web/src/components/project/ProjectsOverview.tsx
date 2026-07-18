import { useMemo, useState } from "react";
import type { Project, ProjectTaskOverview, TaskStatus } from "@aif/shared/browser";
import { STATUS_CONFIG } from "@aif/shared/browser";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatusDot } from "@/components/ui/status-dot";
import { Skeleton } from "@/components/ui/skeleton";
import { Metric } from "@/components/ui/metric";
import { Select } from "@/components/ui/select";
import { useProjectTaskOverviews } from "@/hooks/useProjects";
import { calculateProjectOverviewMetrics } from "@/lib/taskMetrics";
import { PROJECT_SORT_OPTIONS, sortProjects, type ProjectSort } from "@/lib/projectSorting";

const integerFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFmt = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtInt = (v: number) => integerFmt.format(Math.round(v));
const fmtUsd = (v: number) => usdFmt.format(v);
const fmtCompact = (v: number) => compactFmt.format(v);

interface ProjectsOverviewProps {
  projects: Project[];
  onSelectProject: (project: Project) => void;
}

const OVERVIEW_STATUSES: TaskStatus[] = [
  "backlog",
  "planning",
  "improve",
  "plan_ready",
  "implementing",
  "verify",
  "review",
  "done",
];

const PREVIEW_LIMIT = 3;

export function ProjectsOverview({ projects, onSelectProject }: ProjectsOverviewProps) {
  const [projectSort, setProjectSort] = useState<ProjectSort>("name");
  const { data: projectTaskOverviews, isLoading } = useProjectTaskOverviews(projects.length > 0);
  const overviewByProjectId = useMemo(() => {
    const map = new Map<string, ProjectTaskOverview>();
    for (const overview of projectTaskOverviews ?? []) {
      map.set(overview.projectId, overview);
    }
    return map;
  }, [projectTaskOverviews]);
  const sortedProjects = useMemo(
    () => sortProjects(projects, projectSort, overviewByProjectId),
    [overviewByProjectId, projectSort, projects],
  );

  if (!projects.length) {
    return (
      <EmptyState
        message="No projects yet"
        description="Create a project from the header to get started."
      />
    );
  }

  return (
    <div className="w-full">
      <SectionHeader
        className="mb-4"
        action={
          <div className="flex items-center gap-2">
            <Select
              value={projectSort}
              options={[...PROJECT_SORT_OPTIONS]}
              onChange={(event) => setProjectSort(event.target.value as ProjectSort)}
              selectSize="sm"
              className="w-36"
            />
            <Badge variant="outline" size="sm">
              {projects.length} project{projects.length === 1 ? "" : "s"}
            </Badge>
          </div>
        }
      >
        Projects overview
      </SectionHeader>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4">
          {sortedProjects.map((p) => (
            <Skeleton key={p.id} className="h-44 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {sortedProjects.map((project) => {
            const overview = overviewByProjectId.get(project.id);
            const metrics = calculateProjectOverviewMetrics(overview);
            const progress = Math.round(metrics.completionRate);
            const isComplete =
              metrics.totalTasks > 0 && metrics.completedTasks === metrics.totalTasks;
            const tokenTotal = project.tokenTotal ?? metrics.totalTokenTotal;
            const costUsd = project.costUsd ?? metrics.totalCostUsd;
            return (
              <Card
                key={project.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectProject(project)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectProject(project);
                  }
                }}
                className="cursor-pointer p-5 transition-colors hover:border-primary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold tracking-tight">
                      {project.name}
                    </h2>
                    {project.rootPath && (
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {project.rootPath}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {project.parallelEnabled && (
                      <Badge variant="secondary" size="sm" title="Parallel execution enabled">
                        Parallel
                      </Badge>
                    )}
                    {project.autoQueueMode && (
                      <Badge variant="secondary" size="sm" title="Auto queue mode enabled">
                        Auto queue
                      </Badge>
                    )}
                    {isComplete && (
                      <Badge variant="default" size="sm">
                        Completed
                      </Badge>
                    )}
                    <Badge variant="outline" size="sm">
                      <span className="font-mono">
                        {metrics.completedTasks} / {metrics.totalTasks}
                      </span>
                    </Badge>
                  </div>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric
                    label="Tokens"
                    value={fmtCompact(tokenTotal)}
                    description={`in ${fmtCompact(metrics.totalTokenInput)} · out ${fmtCompact(metrics.totalTokenOutput)}`}
                  />
                  <Metric
                    label="Cost"
                    value={fmtUsd(costUsd)}
                    description={`avg ${fmtUsd(metrics.averageCostPerTaskUsd)} / task`}
                  />
                  <Metric
                    label="Active"
                    value={fmtInt(metrics.activeTasks)}
                    description="in progress"
                  />
                  <Metric
                    label="Backlog"
                    value={fmtInt(metrics.backlogTasks)}
                    description="waiting"
                  />
                  <Metric
                    label="Blocked"
                    value={fmtInt(metrics.blockedTasks)}
                    description="external"
                  />
                  <Metric
                    label="Auto / Fix / Retry"
                    value={`${fmtInt(metrics.autoModeTasks)} / ${fmtInt(metrics.fixTasks)} / ${fmtInt(metrics.totalRetries)}`}
                    description="task flags"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {OVERVIEW_STATUSES.map((status) => {
                    const count = overview?.statusCounts[status] ?? 0;
                    const items = overview?.statusPreviews[status] ?? [];
                    const config = STATUS_CONFIG[status];
                    return (
                      <Card key={status} variant="muted" className="p-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <StatusDot status={status} size="sm" />
                            <span className="truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                              {config.label}
                            </span>
                          </div>
                          <Badge variant="secondary" size="xs">
                            {count}
                          </Badge>
                        </div>
                        {items.length === 0 ? (
                          <p className="text-2xs text-muted-foreground/60">—</p>
                        ) : (
                          <ul className="space-y-0.5">
                            {items.slice(0, PREVIEW_LIMIT).map((task) => (
                              <li
                                key={task.id}
                                className="truncate text-2xs text-muted-foreground"
                                title={task.title}
                              >
                                {task.title}
                              </li>
                            ))}
                            {count > PREVIEW_LIMIT && (
                              <li className="text-2xs text-muted-foreground/60">
                                +{count - PREVIEW_LIMIT} more
                              </li>
                            )}
                          </ul>
                        )}
                      </Card>
                    );
                  })}
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <ProgressBar value={progress} className="flex-1" />
                  <span className="w-10 text-right font-mono text-2xs text-muted-foreground">
                    {progress}%
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
