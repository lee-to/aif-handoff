import type { CSSProperties, MouseEvent } from "react";
import { ChevronUp, ChevronDown, Clock, Pause, Play } from "lucide-react";
import { STATUS_CONFIG, type Task } from "@aif/shared/browser";
import { Badge } from "@/components/ui/badge";
import { TaskTagsList } from "@/components/ui/task-tags-list";
import { timeAgo } from "@/lib/utils";
import { getRuntimeLimitDisplay } from "@/lib/runtimeLimits";
import { useUsageLimitsEnabled } from "@/hooks/useSettings";

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
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onTogglePause?: () => void;
}

function shortTaskId(id: string) {
  return id.slice(0, 8);
}

export function TaskCard({
  task,
  onClick,
  overlay,
  density = "comfortable",
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onTogglePause,
}: TaskCardProps) {
  const priority = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS[0];
  const isCompact = density === "compact";
  const showReorder =
    task.status === "backlog" && (onMoveUp !== undefined || onMoveDown !== undefined);
  const showPauseToggle = task.status === "backlog" && onTogglePause !== undefined;
  const usageLimitsEnabled = useUsageLimitsEnabled();
  const runtimeLimitDisplay = usageLimitsEnabled
    ? getRuntimeLimitDisplay(task.runtimeLimitSnapshot, {
        taskRetryAfter: task.retryAfter ?? null,
        checkedAt: task.runtimeLimitUpdatedAt ?? null,
      })
    : null;

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
  };

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

      {task.scheduledAt && task.status === "backlog" && (
        <div className="mt-2 ml-2 flex items-center gap-1.5 border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-3xs text-sky-700 dark:text-sky-300">
          <Clock className="h-3 w-3 shrink-0" />
          <span>
            Starts{" "}
            <span className="font-medium">
              {new Date(task.scheduledAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </span>
        </div>
      )}

      {(showReorder || showPauseToggle) && (
        <div className="mt-2 ml-2 flex items-center gap-1">
          {showReorder && (
            <>
              <button
                type="button"
                aria-label="Move task up"
                disabled={!canMoveUp}
                onClick={(e) => {
                  stop(e);
                  onMoveUp?.();
                }}
                className="flex h-5 w-5 items-center justify-center border border-border bg-secondary/50 text-muted-foreground transition hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label="Move task down"
                disabled={!canMoveDown}
                onClick={(e) => {
                  stop(e);
                  onMoveDown?.();
                }}
                className="flex h-5 w-5 items-center justify-center border border-border bg-secondary/50 text-muted-foreground transition hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </>
          )}
          {showPauseToggle && (
            <button
              type="button"
              aria-label={task.paused ? "Resume task" : "Pause task"}
              title={
                task.paused
                  ? "Paused — auto-queue and scheduler will skip this task. Click to resume."
                  : "Pause — exclude from auto-queue and scheduled execution"
              }
              onClick={(e) => {
                stop(e);
                onTogglePause?.();
              }}
              className={`flex h-5 w-5 items-center justify-center border transition ${
                task.paused
                  ? "border-yellow-500/50 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300"
                  : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              {task.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
          )}
        </div>
      )}

      {task.status === "blocked_external" && runtimeLimitDisplay && (
        <div className="mt-2 ml-2 border border-red-500/30 bg-red-500/10 px-2 py-1 text-3xs text-red-300">
          <div className="font-medium">
            {runtimeLimitDisplay.state === "active" ? "Runtime auto-pause" : "Runtime limit status"}
          </div>
          <div className="line-clamp-2">{runtimeLimitDisplay.summary}</div>
          {runtimeLimitDisplay.resetText && (
            <div className="line-clamp-1">{runtimeLimitDisplay.resetText}</div>
          )}
          {runtimeLimitDisplay.taskRetryText && (
            <div className="line-clamp-1">{runtimeLimitDisplay.taskRetryText}</div>
          )}
        </div>
      )}

      {task.status === "blocked_external" && !runtimeLimitDisplay && task.blockedReason && (
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
