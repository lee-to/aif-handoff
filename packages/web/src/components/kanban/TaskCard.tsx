import type { CSSProperties } from "react";
import { STATUS_CONFIG, type Task } from "@aif/shared/browser";
import { Badge } from "@/components/ui/badge";
import { TaskTagsList } from "@/components/ui/task-tags-list";
import { timeAgo } from "@/lib/utils";

const PRIORITY_LABELS: Record<number, { label: string; className: string }> = {
  0: { label: "None", className: "hidden" },
  1: { label: "Low", className: "border-cyan-500/35 bg-cyan-500/15 text-cyan-300" },
  2: { label: "Medium", className: "border-amber-500/35 bg-amber-500/15 text-amber-300" },
  3: { label: "High", className: "border-orange-500/35 bg-orange-500/15 text-orange-300" },
  4: { label: "Urgent", className: "border-red-500/35 bg-red-500/15 text-red-300" },
  5: { label: "Critical", className: "border-red-600/35 bg-red-600/15 text-red-200" },
};

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  overlay?: boolean;
  density?: "comfortable" | "compact";
}

function shortTaskId(id: string) {
  return id.slice(0, 8);
}

export function TaskCard({ task, onClick, overlay, density = "comfortable" }: TaskCardProps) {
  const priority = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS[0];
  const isCompact = density === "compact";

  if (overlay) {
    return (
      <div className="w-80 rotate-1 border border-border bg-card p-3">
        <div className="text-sm font-medium tracking-tight">{task.title}</div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`group relative cursor-pointer overflow-hidden border border-border bg-card/95 transition-transform duration-150 hover:-translate-y-0.5 ${
        isCompact ? "p-2" : "p-3"
      }`}
      style={{ "--status-color": STATUS_CONFIG[task.status].color } as CSSProperties}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 border opacity-0 transition-opacity duration-150 group-hover:opacity-60"
        style={{ borderColor: `var(--status-color)` }}
      />

      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 ${isCompact ? "w-1" : "w-1.5"}`}
        style={{ backgroundColor: `var(--status-color)` }}
      />

      <div className={`flex items-start justify-between ${isCompact ? "gap-1.5" : "gap-2"}`}>
        <div
          className={`${isCompact ? "pl-1.5 text-xs" : "pl-2 text-sm"} font-medium leading-tight tracking-tight`}
        >
          {task.title}
        </div>
        <div className="flex shrink-0 flex-wrap items-start justify-end gap-1">
          {task.manualReviewRequired && (
            <Badge
              size={isCompact ? "xs" : "sm"}
              className="border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            >
              Manual Review
            </Badge>
          )}
          {priority.label !== "None" && (
            <Badge size={isCompact ? "xs" : "sm"} className={priority.className}>
              {priority.label}
            </Badge>
          )}
        </div>
      </div>

      {task.description && (
        <div
          className={`line-clamp-2 text-muted-foreground ${isCompact ? "mt-0.5 pl-1.5 text-2xs" : "mt-1.5 pl-2 text-xs"}`}
        >
          {task.description}
        </div>
      )}

      <TaskTagsList
        tags={task.tags}
        roadmapAlias={task.roadmapAlias ?? undefined}
        isCompact={isCompact}
        className={isCompact ? "mt-0.5 pl-1.5" : "mt-1.5 pl-2"}
      />

      {task.status === "blocked_external" && task.blockedReason && (
        <div className="mt-2 ml-2 border border-red-500/30 bg-red-500/10 px-2 py-1 text-3xs text-red-300 line-clamp-2">
          {task.blockedReason}
        </div>
      )}

      {task.manualReviewRequired && (
        <div className="mt-2 ml-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-3xs text-amber-700 dark:text-amber-300 line-clamp-2">
          Auto-review stopped. Human review required.
        </div>
      )}

      <div
        className={`border-t border-border font-mono text-muted-foreground/70 ${
          isCompact ? "mt-1.5 pl-1.5 pt-1 text-4xs" : "mt-2 pl-2 pt-2 text-3xs"
        }`}
      >
        #{shortTaskId(task.id)} · {timeAgo(task.updatedAt)} · {task.autoMode ? "AI" : "MANUAL"}
        {task.paused && (
          <Badge
            size={isCompact ? "xs" : "sm"}
            className="ml-1.5 border-yellow-500/35 bg-yellow-500/15 text-yellow-600 dark:text-yellow-300"
          >
            PAUSED
          </Badge>
        )}
      </div>
    </div>
  );
}
