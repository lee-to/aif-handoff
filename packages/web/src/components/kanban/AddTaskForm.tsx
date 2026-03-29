import { useState } from "react";
import { Plus, X, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateTask } from "@/hooks/useTasks";

interface Props {
  projectId: string;
}

export function AddTaskForm({ projectId }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [autoMode, setAutoMode] = useState(true);
  const [isFix, setIsFix] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [plannerMode, setPlannerMode] = useState<"full" | "fast">("full");
  const [planPath, setPlanPath] = useState(".ai-factory/PLAN.md");
  const [planDocs, setPlanDocs] = useState(false);
  const [planTests, setPlanTests] = useState(false);
  const [skipReview, setSkipReview] = useState(false);
  const createTask = useCreateTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    console.debug("[kanban] Creating task:", title);
    createTask.mutate(
      {
        projectId,
        title: title.trim(),
        description: description.trim(),
        autoMode,
        isFix,
        plannerMode,
        planPath: planPath.trim() || ".ai-factory/PLAN.md",
        planDocs,
        planTests,
        skipReview,
      },
      {
        onSuccess: () => {
          setTitle("");
          setDescription("");
          setAutoMode(true);
          setIsFix(false);
          setShowAdvanced(false);
          setPlannerMode("full");
          setPlanPath(".ai-factory/PLAN.md");
          setPlanDocs(false);
          setPlanTests(false);
          setSkipReview(false);
          setIsOpen(false);
        },
        onError: (error) => {
          console.error("[kanban] Failed to create task", error);
        },
      },
    );
  };

  if (!isOpen) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-center gap-1 border border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
        onClick={() => setIsOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Add task
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border border-border bg-background/65 p-2.5">
      <Input
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <Textarea
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
      />
      <div className="space-y-2 border border-border/60 bg-muted/20 p-2">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Task type
          </p>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="radio"
              name="taskType"
              aria-label="Standard"
              checked={!isFix}
              onChange={() => setIsFix(false)}
              className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            <span>
              <span className="font-medium text-foreground">Standard</span>
              {" - Default task flow."}
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="radio"
              name="taskType"
              aria-label="Fix"
              checked={isFix}
              onChange={() => setIsFix(true)}
              className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            <span>
              <span className="font-medium text-foreground">Fix</span>
              {
                " - Use when something is not working correctly or is broken; a patch will be created for the self-learning system."
              }
            </span>
          </label>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Auto mode"
            checked={autoMode}
            onChange={(e) => setAutoMode(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary)]"
          />
          <span>
            <span className="font-medium text-foreground">Auto mode</span>
            {
              " - AI moves tasks between statuses automatically; the user only starts the process and verifies the result."
            }
          </span>
        </label>
      </div>
      {!isFix && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Planner settings
          </button>
          {showAdvanced && (
            <div className="space-y-2 border border-border/60 bg-muted/20 p-2">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Mode
                </p>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="plannerMode"
                      checked={plannerMode === "full"}
                      onChange={() => setPlannerMode("full")}
                      className="h-3.5 w-3.5 accent-[var(--color-primary)]"
                    />
                    <span className="font-medium text-foreground">Full</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="plannerMode"
                      checked={plannerMode === "fast"}
                      onChange={() => setPlannerMode("fast")}
                      className="h-3.5 w-3.5 accent-[var(--color-primary)]"
                    />
                    <span className="font-medium text-foreground">Fast</span>
                  </label>
                </div>
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
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={planDocs}
                    onChange={(e) => setPlanDocs(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-primary)]"
                  />
                  <span className="font-medium text-foreground">Docs</span>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={planTests}
                    onChange={(e) => setPlanTests(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-primary)]"
                  />
                  <span className="font-medium text-foreground">Tests</span>
                </label>
              </div>
            </div>
          )}
        </div>
      )}
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={skipReview}
          onChange={(e) => setSkipReview(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary)]"
        />
        <span>
          <span className="font-medium text-foreground">Skip review</span>
          {" - After implementation, move directly to done without code review."}
        </span>
      </label>
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={!title.trim() || createTask.isPending}>
          {createTask.isPending ? "Adding..." : "Add"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setIsOpen(false);
            setTitle("");
            setDescription("");
            setAutoMode(true);
            setIsFix(false);
            setShowAdvanced(false);
            setPlannerMode("full");
            setPlanPath(".ai-factory/PLAN.md");
            setPlanDocs(false);
            setPlanTests(false);
            setSkipReview(false);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
