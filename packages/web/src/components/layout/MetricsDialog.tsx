import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TaskMetricsSummary } from "@/lib/taskMetrics";
import type { Project } from "@aif/shared/browser";

interface MetricsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskMetrics: TaskMetricsSummary;
  project: Project | null;
}

const integerFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtInt = (v: number) => integerFmt.format(Math.round(v));
const fmtUsd = (v: number) => usdFmt.format(v);
const fmtPct = (v: number) => `${v.toFixed(1)}%`;

export function MetricsDialog({ open, onOpenChange, taskMetrics, project }: MetricsDialogProps) {
  // Project-level totals include ALL sources (tasks + chat + commit + roadmap).
  // Fall back to task-only totals when no project is selected.
  const projectTokenTotal = project?.tokenTotal ?? taskMetrics.totalTokenTotal;
  const projectTokenInput = project?.tokenInput ?? taskMetrics.totalTokenInput;
  const projectTokenOutput = project?.tokenOutput ?? taskMetrics.totalTokenOutput;
  const projectCostUsd = project?.costUsd ?? taskMetrics.totalCostUsd;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle>Metrics</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Completed tasks</p>
            <p className="text-lg font-semibold">{fmtInt(taskMetrics.completedTasks)}</p>
            <p className="text-xs text-muted-foreground">
              {fmtPct(taskMetrics.completionRate)} of {fmtInt(taskMetrics.totalTasks)}
            </p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Total token usage</p>
            <p className="text-lg font-semibold">{fmtInt(projectTokenTotal)}</p>
            <p className="text-xs text-muted-foreground">
              in {fmtInt(projectTokenInput)} / out {fmtInt(projectTokenOutput)}
            </p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Total cost</p>
            <p className="text-lg font-semibold">{fmtUsd(projectCostUsd)}</p>
            <p className="text-xs text-muted-foreground">
              tasks: {fmtUsd(taskMetrics.totalCostUsd)}
            </p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Average tokens per task</p>
            <p className="text-lg font-semibold">{fmtInt(taskMetrics.averageTokensPerTask)}</p>
            <p className="text-xs text-muted-foreground">across all tracked tasks</p>
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Active</p>
            <p className="text-base font-medium">{fmtInt(taskMetrics.activeTasks)}</p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Blocked</p>
            <p className="text-base font-medium">{fmtInt(taskMetrics.blockedTasks)}</p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Backlog</p>
            <p className="text-base font-medium">{fmtInt(taskMetrics.backlogTasks)}</p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Verified</p>
            <p className="text-base font-medium">{fmtInt(taskMetrics.verifiedTasks)}</p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Auto mode tasks</p>
            <p className="text-base font-medium">{fmtInt(taskMetrics.autoModeTasks)}</p>
          </div>
          <div className="border border-border bg-card/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">Fix tasks / Retries</p>
            <p className="text-base font-medium">
              {fmtInt(taskMetrics.fixTasks)} / {fmtInt(taskMetrics.totalRetries)}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
