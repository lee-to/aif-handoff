import { useState } from "react";
import { Cpu, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Radio } from "@/components/ui/radio";
import { Select } from "@/components/ui/select";
import { useProjects } from "@/hooks/useProjects";
import { useAppRuntimeDefaults, useRuntimeProfiles, useRuntimes } from "@/hooks/useRuntimeProfiles";
import { formatRuntimeProfileOptionLabel } from "@/lib/runtimeProfiles";
import { defaultsForMode, type Task, type UpdateTaskInput } from "@aif/shared/browser";

interface Props {
  task: Task;
  onSave: (input: UpdateTaskInput) => void;
}

export function TaskSettings({ task, onSave }: Props) {
  const { data: projectsList } = useProjects();
  const { data: appRuntimeDefaults } = useAppRuntimeDefaults();
  const { data: runtimeProfiles = [] } = useRuntimeProfiles(task.projectId, true);
  const { data: runtimes = [] } = useRuntimes();
  const project = projectsList?.find((p) => p.id === task.projectId);
  const isParallel = project?.parallelEnabled ?? false;
  const runtimeDefaultLabel = project?.defaultTaskRuntimeProfileId
    ? "(project default)"
    : appRuntimeDefaults?.resolvedDefaultTaskRuntimeProfileId
      ? "(app default)"
      : "(env fallback)";
  const selectableRuntimeProfiles = runtimeProfiles.filter((profile) => profile.enabled !== false);
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
  const [runtimeProfileId, setRuntimeProfileId] = useState(task.runtimeProfileId ?? "");
  const [modelOverride, setModelOverride] = useState(task.modelOverride ?? "");
  const [scheduledAtLocal, setScheduledAtLocal] = useState(isoToLocalInput(task.scheduledAt));
  const [priority, setPriority] = useState(task.priority ?? 0);
  const [runtimeOverrideOpen, setRuntimeOverrideOpen] = useState(
    Boolean(task.runtimeProfileId || task.modelOverride),
  );

  const selectedRuntimeProfile =
    runtimeProfiles.find((profile) => profile.id === runtimeProfileId) ?? null;
  const selectedRuntimeDescriptor = selectedRuntimeProfile
    ? runtimes.find((runtime) => runtime.id === selectedRuntimeProfile.runtimeId)
    : null;

  const showPlanner = !task.isFix && task.status !== "done";
  const currentScheduledIso = localInputToIso(scheduledAtLocal);
  const hasChanges =
    autoMode !== task.autoMode ||
    skipReview !== task.skipReview ||
    useSubagents !== task.useSubagents ||
    maxReviewIterations !== task.maxReviewIterations ||
    (runtimeProfileId || null) !== (task.runtimeProfileId ?? null) ||
    (modelOverride.trim() || null) !== (task.modelOverride ?? null) ||
    currentScheduledIso !== (task.scheduledAt ?? null) ||
    priority !== (task.priority ?? 0) ||
    (showPlanner &&
      (plannerMode !== task.plannerMode ||
        planPath !== task.planPath ||
        planDocs !== task.planDocs ||
        planTests !== task.planTests));

  function handleSave() {
    const input: UpdateTaskInput = {};
    if (autoMode !== task.autoMode) input.autoMode = autoMode;
    if (skipReview !== task.skipReview) input.skipReview = skipReview;
    if (useSubagents !== task.useSubagents) input.useSubagents = useSubagents;
    if (maxReviewIterations !== task.maxReviewIterations)
      input.maxReviewIterations = maxReviewIterations;
    if ((runtimeProfileId || null) !== (task.runtimeProfileId ?? null)) {
      input.runtimeProfileId = runtimeProfileId || null;
    }
    if ((modelOverride.trim() || null) !== (task.modelOverride ?? null)) {
      input.modelOverride = modelOverride.trim() || null;
    }
    if (currentScheduledIso !== (task.scheduledAt ?? null)) {
      input.scheduledAt = currentScheduledIso;
    }
    if (priority !== (task.priority ?? 0)) {
      input.priority = priority;
    }
    if (showPlanner) {
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
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
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
            <Button size="xs" onClick={handleSave}>
              Save
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setAutoMode(task.autoMode);
              setSkipReview(task.skipReview);
              setUseSubagents(task.useSubagents);
              setMaxReviewIterations(task.maxReviewIterations);
              setPlannerMode(task.plannerMode as "full" | "fast");
              setPlanPath(task.planPath);
              setPlanDocs(task.planDocs);
              setPlanTests(task.planTests);
              setRuntimeProfileId(task.runtimeProfileId ?? "");
              setModelOverride(task.modelOverride ?? "");
              setScheduledAtLocal(isoToLocalInput(task.scheduledAt));
              setPriority(task.priority ?? 0);
              setOpen(false);
            }}
          >
            Close
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <CheckboxField label="Auto mode" checked={autoMode} onChange={setAutoMode}>
          AI moves tasks between statuses automatically.
        </CheckboxField>
        <CheckboxField label="Skip review" checked={skipReview} onChange={setSkipReview}>
          After implementation, move directly to done without code review.
        </CheckboxField>
        <CheckboxField label="Use subagents" checked={useSubagents} onChange={setUseSubagents}>
          Run via custom subagents (plan-coordinator, implement-coordinator, sidecars).
        </CheckboxField>
      </div>

      {autoMode && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Max review iterations
          </p>
          <Input
            type="number"
            min={1}
            max={50}
            value={maxReviewIterations}
            onChange={(e) => setMaxReviewIterations(Math.max(1, parseInt(e.target.value) || 1))}
            inputSize="sm"
            className="w-20"
          />
          <p className="text-3xs text-muted-foreground">
            Max review→implement cycles before auto-completing the task.
          </p>
        </div>
      )}

      {showPlanner && (
        <div className="space-y-2 border-t border-border/60 pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Planner
          </p>
          {isParallel ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Full</span>
              <span className="ml-1.5 text-3xs">(required by parallel mode)</span>
            </p>
          ) : (
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Radio
                  name="plannerModeDetail"
                  checked={plannerMode === "full"}
                  onChange={() => {
                    setPlannerMode("full");
                    const flags = defaultsForMode("full");
                    setSkipReview(flags.skipReview);
                    setPlanDocs(flags.planDocs);
                    setPlanTests(flags.planTests);
                  }}
                  className="h-3.5 w-3.5"
                />
                <span className="font-medium text-foreground">Full</span>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Radio
                  name="plannerModeDetail"
                  checked={plannerMode === "fast"}
                  onChange={() => {
                    setPlannerMode("fast");
                    const flags = defaultsForMode("fast");
                    setSkipReview(flags.skipReview);
                    setPlanDocs(flags.planDocs);
                    setPlanTests(flags.planTests);
                  }}
                  className="h-3.5 w-3.5"
                />
                <span className="font-medium text-foreground">Fast</span>
              </label>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Plan file path
            </p>
            {isParallel ? (
              <p className="text-xs font-mono text-muted-foreground truncate">
                {planPath}
                <span className="ml-1.5 font-sans text-3xs">(locked in parallel mode)</span>
              </p>
            ) : (
              <Input
                value={planPath}
                onChange={(e) => setPlanPath(e.target.value)}
                placeholder=".ai-factory/PLAN.md"
                inputSize="sm"
              />
            )}
          </div>
          <div className="flex gap-4">
            <CheckboxField label="Docs" checked={planDocs} onChange={setPlanDocs} />
            <CheckboxField label="Tests" checked={planTests} onChange={setPlanTests} />
          </div>
        </div>
      )}

      <div className="space-y-1 border-t border-border/60 pt-2">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Priority
        </p>
        <Select
          selectSize="sm"
          value={String(priority)}
          onChange={(e) => setPriority(Number(e.target.value))}
          options={[
            { value: "0", label: "None" },
            { value: "1", label: "Low" },
            { value: "2", label: "Medium" },
            { value: "3", label: "High" },
            { value: "4", label: "Urgent" },
            { value: "5", label: "Critical" },
          ]}
          className="w-40"
        />
        <p className="text-3xs text-muted-foreground">
          Affects ordering in the list view (Priority sort) and the colored badge on the card. Does
          not change agent processing order.
        </p>
      </div>

      {task.status === "backlog" && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Scheduled start
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="datetime-local"
              value={scheduledAtLocal}
              onChange={(e) => setScheduledAtLocal(e.target.value)}
              inputSize="sm"
              className="w-56"
            />
            {scheduledAtLocal && (
              <Button variant="ghost" size="xs" onClick={() => setScheduledAtLocal("")}>
                Clear
              </Button>
            )}
          </div>
          <p className="text-3xs text-muted-foreground">
            Task fires into planning automatically at the chosen time. Must be in the future.
          </p>
        </div>
      )}

      <div className="space-y-2 border-t border-border/60 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRuntimeOverrideOpen((v) => !v)}
          className="gap-1.5 text-muted-foreground"
        >
          <Cpu className="h-3.5 w-3.5" />
          Runtime override
        </Button>
        {runtimeOverrideOpen && (
          <div className="space-y-2 border border-border/60 bg-muted/20 p-2">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Runtime profile
              </p>
              <select
                className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                value={runtimeProfileId}
                onChange={(e) => setRuntimeProfileId(e.target.value)}
              >
                <option value="">{runtimeDefaultLabel}</option>
                {selectableRuntimeProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {formatRuntimeProfileOptionLabel(profile)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Model override
              </p>
              <Input
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder="runtime default"
                className="h-7 text-xs"
              />
            </div>
            {selectedRuntimeDescriptor &&
              !selectedRuntimeDescriptor.capabilities.supportsAgentDefinitions && (
                <p className="text-[10px] text-muted-foreground">
                  This runtime does not support subagents — skills mode will be used instead.
                </p>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function CheckboxField({
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
      <Checkbox
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <span>
        <span className="font-medium text-foreground">{label}</span>
        {children && <> - {children}</>}
      </span>
    </label>
  );
}
