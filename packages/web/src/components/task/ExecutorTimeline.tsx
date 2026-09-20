import { STATUS_CONFIG } from "@aif/shared/browser";
import { useTaskExecutorHistory } from "@/hooks/useTasks";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { TaskOwnershipSummary } from "./TaskOwnership";

interface ExecutorTimelineProps {
  taskId: string;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ExecutorTimeline({ taskId }: ExecutorTimelineProps) {
  const { data: history, isLoading } = useTaskExecutorHistory(taskId);

  if (isLoading) return <EmptyState message="Loading executor history..." />;
  if (!history?.length) return <EmptyState message="No executor history yet" />;

  return (
    <ol className="space-y-3">
      {history.map((entry) => (
        <li key={entry.id} className="border-l-2 border-border pl-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" size="xs">
                revision {entry.ownershipRevision}
              </Badge>
              <span className="text-2xs text-muted-foreground">
                {STATUS_CONFIG[entry.statusSnapshot].label}
              </span>
            </div>
            <time className="text-3xs text-muted-foreground">{formatWhen(entry.createdAt)}</time>
          </div>
          <div className="mt-1.5">
            <TaskOwnershipSummary
              executionOwner={entry.executionOwner}
              assignees={entry.assignees}
              compact
            />
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            Changed by {entry.actor.displayNameSnapshot ?? entry.actor.kind}
          </p>
          {entry.reason && <p className="mt-1 text-xs text-foreground/85">{entry.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
