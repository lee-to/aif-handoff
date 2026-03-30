import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Task, UpdateTaskInput } from "@aif/shared/browser";

interface Props {
  task: Task;
  onSave: (input: UpdateTaskInput) => void;
}

export function TaskSettings({ task, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [autoMode, setAutoMode] = useState(task.autoMode);
  const [skipReview, setSkipReview] = useState(task.skipReview);
  const [useSubagents, setUseSubagents] = useState(task.useSubagents);
  const [plannerMode, setPlannerMode] = useState<"full" | "fast">(
    task.plannerMode as "full" | "fast",
  );
  const [planPath, setPlanPath] = useState(task.planPath);
  const [planDocs, setPlanDocs] = useState(task.planDocs);
  const [planTests, setPlanTests] = useState(task.planTests);
  const [maxReviewIterations, setMaxReviewIterations] = useState(task.maxReviewIterations);

  const hasChanges =
    autoMode !== task.autoMode ||
    skipReview !== task.skipReview ||
    useSubagents !== task.useSubagents ||
    maxReviewIterations !== task.maxReviewIterations ||
    plannerMode !== task.plannerMode ||
    planPath !== task.planPath ||
    planDocs !== task.planDocs ||
    planTests !== task.planTests;

  function handleSave() {
    const input: UpdateTaskInput = {};
    if (autoMode !== task.autoMode) input.autoMode = autoMode;
    if (skipReview !== task.skipReview) input.skipReview = skipReview;
    if (useSubagents !== task.useSubagents) input.useSubagents = useSubagents;
    if (maxReviewIterations !== task.maxReviewIterations)
      input.maxReviewIterations = maxReviewIterations;
    if (!task.isFix) {
      if (plannerMode !== task.plannerMode) input.plannerMode = plannerMode;
      if (planPath !== task.planPath) input.planPath = planPath;
      if (planDocs !== task.planDocs) input.planDocs = planDocs;
      if (planTests !== task.planTests) input.planTests = planTests;
    }
    onSave(input);
    setOpen(false);
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="h-3.5 w-3.5" />
        Settings
      </Button>
    );
  }

  return (
    <div className="space-y-3 border border-border bg-background/55 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Task Settings
        </h4>
        <div className="flex gap-1.5">
          {hasChanges && (
            <Button size="sm" className="h-6 px-2 text-[10px]" onClick={handleSave}>
              Save
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              setAutoMode(task.autoMode);
              setSkipReview(task.skipReview);
              setUseSubagents(task.useSubagents);
              setMaxReviewIterations(task.maxReviewIterations);
              setPlannerMode(task.plannerMode as "full" | "fast");
              setPlanPath(task.planPath);
              setPlanDocs(task.planDocs);
              setPlanTests(task.planTests);
              setOpen(false);
            }}
          >
            Close
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Checkbox label="Auto mode" checked={autoMode} onChange={setAutoMode}>
          AI moves tasks between statuses automatically.
        </Checkbox>
        <Checkbox label="Skip review" checked={skipReview} onChange={setSkipReview}>
          After implementation, move directly to done without code review.
        </Checkbox>
        <Checkbox label="Use subagents" checked={useSubagents} onChange={setUseSubagents}>
          Run via custom subagents (plan-coordinator, implement-coordinator, sidecars).
        </Checkbox>
      </div>

      {autoMode && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Max review iterations
          </p>
          <Input
            type="number"
            min={1}
            max={50}
            value={maxReviewIterations}
            onChange={(e) => setMaxReviewIterations(Math.max(1, parseInt(e.target.value) || 1))}
            className="h-7 w-20 text-xs"
          />
          <p className="text-[10px] text-muted-foreground">
            Max review→implement cycles before auto-completing the task.
          </p>
        </div>
      )}

      {!task.isFix && (
        <div className="space-y-2 border-t border-border/60 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Planner
          </p>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="radio"
                name="plannerModeDetail"
                checked={plannerMode === "full"}
                onChange={() => setPlannerMode("full")}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              <span className="font-medium text-foreground">Full</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="radio"
                name="plannerModeDetail"
                checked={plannerMode === "fast"}
                onChange={() => setPlannerMode("fast")}
                className="h-3.5 w-3.5 accent-[var(--color-primary)]"
              />
              <span className="font-medium text-foreground">Fast</span>
            </label>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Plan file path
            </p>
            <Input
              value={planPath}
              onChange={(e) => setPlanPath(e.target.value)}
              placeholder=".ai-factory/PLAN.md"
              className="h-7 text-xs"
            />
          </div>
          <div className="flex gap-4">
            <Checkbox label="Docs" checked={planDocs} onChange={setPlanDocs} />
            <Checkbox label="Tests" checked={planTests} onChange={setPlanTests} />
          </div>
        </div>
      )}
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary)]"
      />
      <span>
        <span className="font-medium text-foreground">{label}</span>
        {children && <> - {children}</>}
      </span>
    </label>
  );
}
