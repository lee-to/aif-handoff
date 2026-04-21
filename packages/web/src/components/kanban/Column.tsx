import type { Task, TaskStatus } from "@aif/shared/browser";
import { STATUS_CONFIG } from "@aif/shared/browser";
import { TaskCard } from "./TaskCard";
import { AddTaskForm } from "./AddTaskForm";
import { useReorderTask, useUpdateTask } from "@/hooks/useTasks";

interface ColumnProps {
  status: TaskStatus;
  tasks: Task[];
  projectId: string;
  onTaskClick: (taskId: string) => void;
  totalVisibleTasks: number;
  density: "comfortable" | "compact";
  hasActiveFilters: boolean;
}

const OWNER_BADGES: Record<TaskStatus, Array<{ label: string; className: string }>> = {
  backlog: [
    { label: "Human controlled", className: "text-cyan-300 border-cyan-500/35 bg-cyan-500/10" },
  ],
  planning: [
    { label: "AI controlled", className: "text-amber-300 border-amber-500/35 bg-amber-500/10" },
  ],
  plan_ready: [
    { label: "AI controlled", className: "text-amber-300 border-amber-500/35 bg-amber-500/10" },
    { label: "Human decision", className: "text-green-300 border-green-500/35 bg-green-500/10" },
  ],
  implementing: [
    { label: "AI controlled", className: "text-amber-300 border-amber-500/35 bg-amber-500/10" },
  ],
  review: [
    { label: "AI controlled", className: "text-amber-300 border-amber-500/35 bg-amber-500/10" },
  ],
  blocked_external: [
    { label: "Human controlled", className: "text-cyan-300 border-cyan-500/35 bg-cyan-500/10" },
  ],
  done: [
    { label: "Human decision", className: "text-green-300 border-green-500/35 bg-green-500/10" },
  ],
  verified: [
    { label: "Human controlled", className: "text-cyan-300 border-cyan-500/35 bg-cyan-500/10" },
  ],
};

function reorderBacklog(
  tasks: Task[],
  idx: number,
  dir: "up" | "down",
  reorder: ReturnType<typeof useReorderTask>,
): void {
  const current = tasks[idx];
  if (!current) return;
  // Backlog is sorted ascending by position. Move up = smaller position.
  if (dir === "up") {
    if (idx === 0) return;
    const above = tasks[idx - 1];
    const aboveAbove = tasks[idx - 2];
    const newPos =
      aboveAbove !== undefined ? (aboveAbove.position + above.position) / 2 : above.position - 100;
    reorder.mutate({ id: current.id, position: newPos });
    return;
  }
  if (idx === tasks.length - 1) return;
  const below = tasks[idx + 1];
  const belowBelow = tasks[idx + 2];
  const newPos =
    belowBelow !== undefined ? (below.position + belowBelow.position) / 2 : below.position + 100;
  reorder.mutate({ id: current.id, position: newPos });
}

export function Column({
  status,
  tasks,
  projectId,
  onTaskClick,
  totalVisibleTasks,
  density,
  hasActiveFilters,
}: ColumnProps) {
  const config = STATUS_CONFIG[status];
  const owners = OWNER_BADGES[status];
  const share = totalVisibleTasks > 0 ? Math.round((tasks.length / totalVisibleTasks) * 100) : 0;
  const isCompact = density === "compact";
  const reorder = useReorderTask();
  const updateTask = useUpdateTask();

  return (
    <div
      className={`flex-shrink-0 border border-border bg-card/70 transition duration-150 hover:border-primary/25 ${
        isCompact ? "w-72 p-2" : "w-80 p-3"
      }`}
    >
      <div
        className={`-mx-1 border-b border-border px-1 ${isCompact ? "mb-2.5 pb-1.5" : "mb-3 pb-2"}`}
      >
        <div className={`flex items-center gap-2 ${isCompact ? "mb-1.5" : "mb-2"}`}>
          <div
            className={`${isCompact ? "h-2 w-2" : "h-2.5 w-2.5"} rounded-full`}
            style={{ backgroundColor: config.color }}
          />
          <h3 className={`${isCompact ? "text-xs" : "text-xs"} font-semibold tracking-tight`}>
            {config.label}
          </h3>
          <span
            className={`ml-auto border border-border bg-secondary text-muted-foreground ${
              isCompact ? "px-1.5 py-0 text-3xs" : "px-2 py-0.5 text-2xs"
            }`}
          >
            {tasks.length}
          </span>
        </div>

        <div
          className={`${isCompact ? "h-[3px]" : "h-1"} overflow-hidden border border-border bg-secondary/60`}
        >
          <div
            className="h-full transition-[width] duration-200"
            style={{ width: `${share}%`, backgroundColor: config.color }}
          />
        </div>
      </div>

      <div className={`flex flex-wrap gap-1.5 ${isCompact ? "mb-2" : "mb-3"}`}>
        {owners.map((owner) => (
          <span
            key={owner.label}
            className={`inline-flex border ${isCompact ? "px-1.5 py-0 text-4xs" : "px-2 py-0.5 text-3xs"} ${owner.className}`}
          >
            {owner.label}
          </span>
        ))}
      </div>

      {status === "backlog" && (
        <div className="mb-2">
          <AddTaskForm projectId={projectId} />
        </div>
      )}

      <div className={`min-h-[100px] ${density === "compact" ? "space-y-1.5" : "space-y-2"}`}>
        {tasks.map((task, idx) => {
          const reorderProps =
            status === "backlog"
              ? {
                  canMoveUp: idx > 0,
                  canMoveDown: idx < tasks.length - 1,
                  onMoveUp: () => reorderBacklog(tasks, idx, "up", reorder),
                  onMoveDown: () => reorderBacklog(tasks, idx, "down", reorder),
                  onTogglePause: () =>
                    updateTask.mutate({ id: task.id, input: { paused: !task.paused } }),
                }
              : {};
          return (
            <TaskCard
              key={task.id}
              task={task}
              density={density}
              onClick={() => onTaskClick(task.id)}
              {...reorderProps}
            />
          );
        })}

        {tasks.length === 0 && (
          <div className="border border-dashed border-border py-8 text-center text-2xs text-muted-foreground">
            {hasActiveFilters ? "// no tasks for current filters" : "// no tasks"}
          </div>
        )}
      </div>
    </div>
  );
}
