import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createSwarmRunSchema } from "@aif/shared/browser";
import { useSwarmConnection, useSwarmRuns } from "@/hooks/useSwarm";
import { api } from "@/lib/api";
import { randomUUID } from "@/lib/uuid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SwarmRunDetail } from "./SwarmRunDetail";

export function SwarmPanel({ projectId }: { projectId: string }) {
  const connection = useSwarmConnection();
  const enabled = connection.data?.enabled === true && connection.data.projectId === projectId;
  const runs = useSwarmRuns(enabled);
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [workers, setWorkers] = useState("5");
  const [budget, setBudget] = useState("");
  const [policy, setPolicy] = useState("integration");
  const [commandId, setCommandId] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const create = useMutation({
    mutationFn: api.createSwarmRun,
    onSuccess: (result) => {
      setCreating(false);
      setSelectedRunId(result.run_id);
      void queryClient.invalidateQueries({ queryKey: ["swarm"] });
    },
  });
  if (connection.isPending) return <p role="status">Loading Swarm connection…</p>;
  if (connection.isError)
    return (
      <Card role="alert">
        Swarm connection unavailable.{" "}
        <Button variant="ghost" onClick={() => void connection.refetch()}>
          Retry
        </Button>
      </Card>
    );
  if (!enabled)
    return (
      <Card className="space-y-2">
        <h2 className="font-semibold">Swarm</h2>
        <p className="text-sm text-muted-foreground">
          Swarm Runtime is not connected to this project. Ask an administrator to configure the
          connection.
        </p>
      </Card>
    );
  if (selectedRunId)
    return (
      <SwarmRunDetail
        key={selectedRunId}
        runId={selectedRunId}
        role={connection.data.role}
        onBack={() => setSelectedRunId(null)}
      />
    );
  const visible = (runs.data?.runs ?? []).filter(
    (run) =>
      (!status || run.status === status) && run.goal.toLowerCase().includes(search.toLowerCase()),
  );
  const attempted = !create.isIdle;
  return (
    <section className="space-y-4" aria-label="Swarm runs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Swarm runs</h2>
          <p className="text-xs text-muted-foreground">
            Role: {connection.data.role} · Last sync:{" "}
            {runs.dataUpdatedAt ? new Date(runs.dataUpdatedAt).toLocaleTimeString() : "never"}
          </p>
        </div>
        {connection.data.role === "owner" && (
          <Button
            disabled={runs.isError || runs.isPending}
            onClick={() => {
              create.reset();
              setValidationError(undefined);
              setCommandId(randomUUID());
              setCreating(true);
            }}
          >
            New Swarm run
          </Button>
        )}
      </div>
      {runs.isError && (
        <Card role="alert" className="border-destructive text-destructive">
          Runtime unavailable — displayed runs are stale. Retrying automatically.
        </Card>
      )}
      {runs.isPending && <p role="status">Connecting to Runtime…</p>}
      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search Swarm runs"
          placeholder="Search goals"
          className="max-w-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          value={status}
          options={[
            { value: "", label: "All run statuses" },
            ...Array.from(new Set(runs.data?.runs.map((run) => run.status) ?? [])).map((value) => ({
              value,
              label: value,
            })),
          ]}
          onChange={(event) => setStatus(event.target.value)}
        />
      </div>
      {visible.map((run) => (
        <Card key={run.id} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setSelectedRunId(run.id)}>
              {run.goal}
            </Button>
            <Badge>{run.status}</Badge>
          </div>
          <p className="text-sm">
            Workers {run.active_workers} / {run.worker_limit} · Tasks {run.completed_tasks} /{" "}
            {run.total_tasks} · Tokens {run.token_total.toLocaleString()} · Cost{" "}
            {run.cost_usd === null ? "unknown" : `$${run.cost_usd.toFixed(2)}`} · Budget{" "}
            {run.budget_usd === null ? "no limit" : `$${run.budget_usd}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Created {new Date(run.created_at).toLocaleString()} · Updated{" "}
            {new Date(run.updated_at).toLocaleTimeString()}
          </p>
          <p className="text-xs text-muted-foreground">
            Last event: {run.last_event?.type ?? "None"}
          </p>
          {run.blockers.length > 0 && (
            <p className="text-xs text-destructive">{run.blockers.join(" · ")}</p>
          )}
        </Card>
      ))}
      {!runs.isPending && !runs.isError && !visible.length && (
        <p className="text-sm text-muted-foreground">No matching Swarm runs.</p>
      )}
      <FormDialog
        open={creating}
        onOpenChange={(open) => {
          if (!create.isPending) setCreating(open);
        }}
        title="New Swarm run"
        error={
          validationError ??
          (create.isError
            ? "Run creation is unconfirmed. Retry with the same command ID."
            : undefined)
        }
        actions={
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={() => setCreating(false)}>
              Back
            </Button>
            <Button
              disabled={create.isPending || runs.isError}
              onClick={() => {
                const result = createSwarmRunSchema.safeParse({
                  command_id: commandId,
                  goal,
                  acceptance_criteria: criteria
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                  worker_limit: Number(workers),
                  budget_usd: budget.trim() ? Number(budget) : null,
                  policy,
                });
                if (!result.success) {
                  setValidationError(result.error.issues[0]?.message ?? "Check run settings");
                  return;
                }
                setValidationError(undefined);
                create.mutate(result.data);
              }}
            >
              {create.isPending ? "Starting…" : create.isError ? "Retry creation" : "Start run"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="swarm-goal" className="text-sm">
              Goal
            </label>
            <Textarea
              id="swarm-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={10000}
              disabled={attempted}
            />
          </div>
          <div>
            <label htmlFor="swarm-criteria" className="text-sm">
              Acceptance criteria (one per line)
            </label>
            <Textarea
              id="swarm-criteria"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              disabled={attempted}
            />
          </div>
          <div className="flex gap-3">
            <div>
              <label htmlFor="swarm-workers" className="text-sm">
                Worker limit
              </label>
              <Input
                id="swarm-workers"
                type="number"
                min={1}
                max={32}
                value={workers}
                onChange={(event) => setWorkers(event.target.value)}
                disabled={attempted}
              />
            </div>
            <div>
              <label htmlFor="swarm-budget" className="text-sm">
                Budget USD (optional)
              </label>
              <Input
                id="swarm-budget"
                type="number"
                min={0.01}
                step="0.01"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                disabled={attempted}
              />
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm">Approval policy</p>
            <Select
              value={policy}
              options={[
                { value: "manual", label: "Manual approval" },
                { value: "integration", label: "Approve integration" },
                { value: "restricted-actions", label: "Approve restricted actions" },
              ]}
              onChange={(event) => setPolicy(event.target.value)}
              disabled={attempted}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Runtime enforces budgets, sandbox restrictions and approval policy. Closing this page
            leaves the run active.
          </p>
        </div>
      </FormDialog>
    </section>
  );
}
