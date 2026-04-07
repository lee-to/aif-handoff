import type { Task } from "@aif/shared/browser";

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

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

export function calculateTaskMetrics(tasks: Task[]): TaskMetricsSummary {
  const totalTasks = tasks.length;

  const completedTasks = tasks.filter(
    (task) => task.status === "done" || task.status === "verified",
  ).length;
  const verifiedTasks = tasks.filter((task) => task.status === "verified").length;
  const backlogTasks = tasks.filter((task) => task.status === "backlog").length;
  const blockedTasks = tasks.filter((task) => task.status === "blocked_external").length;
  const activeTasks = tasks.filter(
    (task) => task.status !== "backlog" && task.status !== "done" && task.status !== "verified",
  ).length;
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

  const averageTokensPerTask = totalTasks > 0 ? totalTokenTotal / totalTasks : 0;
  const averageCostPerTaskUsd = totalTasks > 0 ? totalCostUsd / totalTasks : 0;
  const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return {
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
    averageTokensPerTask,
    totalCostUsd,
    averageCostPerTaskUsd,
    completionRate,
  };
}
