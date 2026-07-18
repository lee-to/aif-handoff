import type { ProjectTaskOverview, TaskListItem, TaskStatus } from "@aif/shared/browser";

export interface TaskMetricsSummary {
  totalTasks: number;
  completedTasks: number;
  verifiedTasks: number;
  backlogTasks: number;
  activeTasks: number;
  blockedTasks: number;
  autoModeTasks: number;
  fixTasks: number;
  totalRetries: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  averageTokensPerTask: number;
  totalCostUsd: number;
  averageCostPerTaskUsd: number;
  completionRate: number;
}

type TaskMetricsInput = Pick<
  TaskListItem,
  | "status"
  | "autoMode"
  | "isFix"
  | "retryCount"
  | "tokenInput"
  | "tokenOutput"
  | "tokenTotal"
  | "costUsd"
>;

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

function buildTaskMetricsSummary(input: {
  totalTasks: number;
  completedTasks: number;
  verifiedTasks: number;
  backlogTasks: number;
  activeTasks: number;
  blockedTasks: number;
  autoModeTasks: number;
  fixTasks: number;
  totalRetries: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalCostUsd: number;
}): TaskMetricsSummary {
  const averageTokensPerTask = input.totalTasks > 0 ? input.totalTokenTotal / input.totalTasks : 0;
  const averageCostPerTaskUsd = input.totalTasks > 0 ? input.totalCostUsd / input.totalTasks : 0;
  const completionRate = input.totalTasks > 0 ? (input.completedTasks / input.totalTasks) * 100 : 0;

  return {
    ...input,
    averageTokensPerTask,
    averageCostPerTaskUsd,
    completionRate,
  };
}

function isActiveStatus(status: TaskStatus): boolean {
  return status !== "backlog" && status !== "done" && status !== "verified";
}

export function calculateTaskMetrics(tasks: TaskMetricsInput[]): TaskMetricsSummary {
  const totalTasks = tasks.length;

  const completedTasks = tasks.filter(
    (task) => task.status === "done" || task.status === "verified",
  ).length;
  const verifiedTasks = tasks.filter((task) => task.status === "verified").length;
  const backlogTasks = tasks.filter((task) => task.status === "backlog").length;
  const blockedTasks = tasks.filter((task) => task.status === "blocked_external").length;
  const activeTasks = tasks.filter((task) => isActiveStatus(task.status)).length;
  const autoModeTasks = tasks.filter((task) => task.autoMode).length;
  const fixTasks = tasks.filter((task) => task.isFix).length;

  const totalRetries = tasks.reduce((sum, task) => sum + toNonNegativeNumber(task.retryCount), 0);
  const totalTokenInput = tasks.reduce(
    (sum, task) => sum + toNonNegativeNumber(task.tokenInput),
    0,
  );
  const totalTokenOutput = tasks.reduce(
    (sum, task) => sum + toNonNegativeNumber(task.tokenOutput),
    0,
  );
  const totalTokenTotal = tasks.reduce(
    (sum, task) => sum + toNonNegativeNumber(task.tokenTotal),
    0,
  );
  const totalCostUsd = tasks.reduce((sum, task) => sum + toNonNegativeNumber(task.costUsd), 0);

  return buildTaskMetricsSummary({
    totalTasks,
    completedTasks,
    verifiedTasks,
    backlogTasks,
    activeTasks,
    blockedTasks,
    autoModeTasks,
    fixTasks,
    totalRetries,
    totalTokenInput,
    totalTokenOutput,
    totalTokenTotal,
    totalCostUsd,
  });
}

export function calculateOverviewMetrics(
  overviews: ProjectTaskOverview[] = [],
): TaskMetricsSummary {
  return buildTaskMetricsSummary(
    overviews.reduce(
      (acc, overview) => ({
        totalTasks: acc.totalTasks + toNonNegativeNumber(overview.totalTasks),
        completedTasks: acc.completedTasks + toNonNegativeNumber(overview.completedTasks),
        verifiedTasks: acc.verifiedTasks + toNonNegativeNumber(overview.verifiedTasks),
        backlogTasks: acc.backlogTasks + toNonNegativeNumber(overview.backlogTasks),
        activeTasks: acc.activeTasks + toNonNegativeNumber(overview.activeTasks),
        blockedTasks: acc.blockedTasks + toNonNegativeNumber(overview.blockedTasks),
        autoModeTasks: acc.autoModeTasks + toNonNegativeNumber(overview.autoModeTasks),
        fixTasks: acc.fixTasks + toNonNegativeNumber(overview.fixTasks),
        totalRetries: acc.totalRetries + toNonNegativeNumber(overview.totalRetries),
        totalTokenInput: acc.totalTokenInput + toNonNegativeNumber(overview.totalTokenInput),
        totalTokenOutput: acc.totalTokenOutput + toNonNegativeNumber(overview.totalTokenOutput),
        totalTokenTotal: acc.totalTokenTotal + toNonNegativeNumber(overview.totalTokenTotal),
        totalCostUsd: acc.totalCostUsd + toNonNegativeNumber(overview.totalCostUsd),
      }),
      {
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
      },
    ),
  );
}

export function calculateProjectOverviewMetrics(
  overview: ProjectTaskOverview | null | undefined,
): TaskMetricsSummary {
  return calculateOverviewMetrics(overview ? [overview] : []);
}
