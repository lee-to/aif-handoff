import type { Task, TaskEvent, TaskStatus } from "@aif/shared/browser";
import { STATUS_CONFIG } from "@aif/shared/browser";
import { Pause, Play } from "lucide-react";
import { SheetHeader, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTokenCount, formatUsd } from "@/lib/formatters";
import { AlertBox } from "@/components/ui/alert-box";
import { TabButton } from "./Section";

export type TaskDetailTab = "implementation" | "review" | "comments" | "activity";

const ACTION_BUTTONS_BY_STATUS: Partial<
  Record<
    TaskStatus,
    Array<{
      label: string;
      event?: TaskEvent;
      actionType?: "event" | "open_replanning" | "open_fast_fix" | "open_request_changes";
      variant?: "default" | "outline";
      visible?: (task: { autoMode: boolean }) => boolean;
    }>
  >
> = {
  backlog: [{ label: "Start AI", event: "start_ai" }],
  plan_ready: [
    {
      label: "Start implementation",
      event: "start_implementation",
      actionType: "event",
      visible: (task) => !task.autoMode,
    },
    {
      label: "Request replanning",
      actionType: "open_replanning",
      variant: "outline",
      visible: (task) => !task.autoMode,
    },
    {
      label: "Fast fix",
      actionType: "open_fast_fix",
      variant: "outline",
      visible: (task) => !task.autoMode,
    },
  ],
  blocked_external: [{ label: "Retry", event: "retry_from_blocked" }],
  done: [
    { label: "Approve", event: "approve_done" },
    { label: "Request changes", actionType: "open_request_changes", variant: "outline" },
  ],
};

interface TaskDetailHeaderProps {
  task: Task;
  activeTab: TaskDetailTab;
  onTabChange: (tab: TaskDetailTab) => void;
  onActionClick: (action: { event?: TaskEvent; actionType?: string }) => void;
  onTogglePaused: () => void;
  isDisabled: boolean;
  isCheckingStartAi: boolean;
  planChangeSuccess: string | null;
  onClose: () => void;
}

export function TaskDetailHeader({
  task,
  activeTab,
  onTabChange,
  onActionClick,
  onTogglePaused,
  isDisabled,
  isCheckingStartAi,
  planChangeSuccess,
  onClose,
}: TaskDetailHeaderProps) {
  const visibleActions = (ACTION_BUTTONS_BY_STATUS[task.status] ?? []).filter(
    (action) => action.visible?.(task) ?? true,
  );
  const showPauseButton = !["backlog", "done", "verified"].includes(task.status);

  return (
    <div className="border-b border-border p-6 pb-4 pr-14">
      <SheetClose onClose={onClose} />
      <SheetHeader className="mb-3">
        <div className="mb-1 flex items-center gap-2">
          <Badge
            className="text-[10px]"
            style={{
              backgroundColor: `${STATUS_CONFIG[task.status].color}20`,
              color: STATUS_CONFIG[task.status].color,
              borderColor: `${STATUS_CONFIG[task.status].color}40`,
            }}
          >
            {STATUS_CONFIG[task.status].label}
          </Badge>
          {task.paused && (
            <Badge className="text-[10px] border-yellow-500/35 bg-yellow-500/15 text-yellow-600 dark:text-yellow-300">
              PAUSED
            </Badge>
          )}
          {task.priority > 0 && (
            <Badge variant="outline" className="text-[10px]">
              P{task.priority}
            </Badge>
          )}
          {task.roadmapAlias && (
            <Badge className="text-[10px] border-violet-500/35 bg-violet-500/15 text-violet-600 dark:text-violet-300">
              {task.roadmapAlias}
            </Badge>
          )}
          {task.tags
            ?.filter((t) => !t.startsWith("rm:") && t !== "roadmap")
            .map((tag) => (
              <Badge
                key={tag}
                className="text-[10px] border-slate-500/35 bg-slate-500/15 text-slate-600 dark:text-slate-300"
              >
                {tag}
              </Badge>
            ))}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            in: {formatTokenCount(task.tokenInput)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            out: {formatTokenCount(task.tokenOutput)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            total: {formatTokenCount(task.tokenTotal)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            cost: {formatUsd(task.costUsd)}
          </Badge>
        </div>
        <SheetTitle className="tracking-tight">{task.title}</SheetTitle>
      </SheetHeader>

      {(showPauseButton || visibleActions.length > 0) && (
        <div className="border border-border bg-background/60 p-3">
          <label className="mb-2 block text-xs text-muted-foreground">Actions</label>
          <div className="flex flex-wrap items-center gap-2">
            {showPauseButton && (
              <Button
                variant={task.paused ? "default" : "outline"}
                size="sm"
                className="gap-1.5"
                onClick={onTogglePaused}
                disabled={isDisabled}
              >
                {task.paused ? (
                  <>
                    <Play className="h-3.5 w-3.5" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </>
                )}
              </Button>
            )}
            {visibleActions.map((action) => (
              <Button
                key={action.event ?? action.label}
                size="sm"
                variant={action.variant}
                onClick={() => onActionClick(action)}
                disabled={isDisabled || isCheckingStartAi}
              >
                {action.event === "start_ai" && isCheckingStartAi ? "Checking..." : action.label}
              </Button>
            ))}
          </div>
          {planChangeSuccess && (
            <AlertBox variant="success" className="mt-2 px-2 py-1.5 text-xs">
              {planChangeSuccess}
            </AlertBox>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border border-border bg-background/55 p-2">
        <TabButton
          active={activeTab === "implementation"}
          onClick={() => onTabChange("implementation")}
        >
          Implementation
        </TabButton>
        <TabButton active={activeTab === "review"} onClick={() => onTabChange("review")}>
          Review
        </TabButton>
        <TabButton active={activeTab === "comments"} onClick={() => onTabChange("comments")}>
          Comments
        </TabButton>
        <TabButton active={activeTab === "activity"} onClick={() => onTabChange("activity")}>
          Activity
        </TabButton>
      </div>
    </div>
  );
}
