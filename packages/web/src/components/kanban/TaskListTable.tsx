import { useMemo } from "react";
import { ChevronUp, ChevronDown, Clock, Pause, Play } from "lucide-react";
import { STATUS_CONFIG, type Task } from "@aif/shared/browser";
import { TableHeaderCell } from "@/components/ui/table-header-cell";
import { useReorderTask, useUpdateTask } from "@/hooks/useTasks";

interface TaskListTableProps {
  tasks: Task[];
  isCompact: boolean;
  onTaskClick: (taskId: string) => void;
  onReorderBacklog?: () => void;
}

export function TaskListTable({
  tasks,
  isCompact,
  onTaskClick,
  onReorderBacklog,
}: TaskListTableProps) {
  const reorder = useReorderTask();
  const updateTask = useUpdateTask();
  const backlogSorted = useMemo(
    () => tasks.filter((t) => t.status === "backlog").sort((a, b) => a.position - b.position),
    [tasks],
  );
  const backlogIndex = useMemo(() => {
    const map = new Map<string, number>();
    backlogSorted.forEach((t, i) => map.set(t.id, i));
    return map;
  }, [backlogSorted]);

  const moveBacklog = (taskId: string, dir: "up" | "down") => {
    const idx = backlogIndex.get(taskId);
    if (idx === undefined) return;
    const current = backlogSorted[idx];
    if (dir === "up") {
      if (idx === 0) return;
      const above = backlogSorted[idx - 1];
      const aboveAbove = backlogSorted[idx - 2];
      const newPos =
        aboveAbove !== undefined
          ? (aboveAbove.position + above.position) / 2
          : above.position - 100;
      reorder.mutate({ id: current.id, position: newPos });
      onReorderBacklog?.();
      return;
    }
    if (idx === backlogSorted.length - 1) return;
    const below = backlogSorted[idx + 1];
    const belowBelow = backlogSorted[idx + 2];
    const newPos =
      belowBelow !== undefined ? (below.position + belowBelow.position) / 2 : below.position + 100;
    reorder.mutate({ id: current.id, position: newPos });
    onReorderBacklog?.();
  };

  return (
    <div className="overflow-x-auto border border-border bg-card/65">
      <table className="w-full table-fixed border-collapse text-left">
        <thead className="border-b border-border bg-secondary/35">
          <tr>
            <TableHeaderCell isCompact={isCompact} className="w-auto">
              Task
            </TableHeaderCell>
            <TableHeaderCell isCompact={isCompact} className="w-28">
              Status
            </TableHeaderCell>
            <TableHeaderCell isCompact={isCompact} className="w-24">
              Priority
            </TableHeaderCell>
            <TableHeaderCell isCompact={isCompact} className="w-20">
              Owner
            </TableHeaderCell>
            <TableHeaderCell isCompact={isCompact} className="w-44">
              Updated
            </TableHeaderCell>
            <TableHeaderCell isCompact={isCompact} className="w-24 text-center">
              Order
            </TableHeaderCell>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className="cursor-pointer border-b border-border/80 transition-colors hover:bg-accent/45"
              onClick={() => onTaskClick(task.id)}
            >
              <td className={`px-3 overflow-hidden ${isCompact ? "py-1" : "py-2.5"}`}>
                <div
                  className={`truncate ${isCompact ? "text-xs" : "text-sm"} font-medium tracking-tight`}
                >
                  {task.title}
                </div>
                {task.description && (
                  <div
                    className={`truncate text-muted-foreground ${isCompact ? "text-2xs" : "text-xs"}`}
                  >
                    {task.description}
                  </div>
                )}
                {task.scheduledAt && task.status === "backlog" && (
                  <div
                    className={`mt-0.5 inline-flex items-center gap-1 border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300 ${
                      isCompact ? "text-3xs" : "text-2xs"
                    }`}
                  >
                    <Clock className="h-3 w-3 shrink-0" />
                    <span>
                      Starts{" "}
                      {new Date(task.scheduledAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                )}
              </td>
              <td className={`px-3 ${isCompact ? "py-1" : "py-2.5"}`}>
                <span
                  className={`inline-flex border ${isCompact ? "px-1.5 py-0 text-3xs" : "px-2 py-0.5 text-2xs"}`}
                  style={{
                    borderColor: `${STATUS_CONFIG[task.status].color}66`,
                    color: STATUS_CONFIG[task.status].color,
                    backgroundColor: `${STATUS_CONFIG[task.status].color}1A`,
                  }}
                >
                  {STATUS_CONFIG[task.status].label}
                </span>
              </td>
              <td
                className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-2xs" : "py-2.5 text-xs"}`}
              >
                {task.priority || "-"}
              </td>
              <td
                className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-2xs" : "py-2.5 text-xs"}`}
              >
                {task.autoMode ? "AI" : "Manual"}
              </td>
              <td
                className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-2xs" : "py-2.5 text-xs"}`}
              >
                {new Date(task.updatedAt).toLocaleString()}
              </td>
              <td
                className={`px-2 ${isCompact ? "py-1" : "py-2.5"}`}
                onClick={(e) => e.stopPropagation()}
              >
                {task.status === "backlog" ? (
                  <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      aria-label="Move task up"
                      disabled={backlogIndex.get(task.id) === 0}
                      onClick={() => moveBacklog(task.id, "up")}
                      className="flex h-5 w-5 items-center justify-center border border-border bg-secondary/50 text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move task down"
                      disabled={backlogIndex.get(task.id) === backlogSorted.length - 1}
                      onClick={() => moveBacklog(task.id, "down")}
                      className="flex h-5 w-5 items-center justify-center border border-border bg-secondary/50 text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={task.paused ? "Resume task" : "Pause task"}
                      title={
                        task.paused
                          ? "Paused — auto-queue and scheduler will skip this task. Click to resume."
                          : "Pause — exclude from auto-queue and scheduled execution"
                      }
                      onClick={() =>
                        updateTask.mutate({
                          id: task.id,
                          input: { paused: !task.paused },
                        })
                      }
                      className={`flex h-5 w-5 items-center justify-center border transition ${
                        task.paused
                          ? "border-yellow-500/50 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300"
                          : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {task.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                    </button>
                  </div>
                ) : (
                  <span className="block text-center text-muted-foreground/40">—</span>
                )}
              </td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">
                No tasks match current list search
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
