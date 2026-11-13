import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SwarmRole } from "@aif/shared/browser";
import { useSwarmRun } from "@/hooks/useSwarm";
import { api } from "@/lib/api";
import { randomUUID } from "@/lib/uuid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible } from "@/components/ui/collapsible";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SwarmTaskGraph } from "./SwarmTaskGraph";

type Command = {
  id: string;
  label: string;
  action: "pause" | "resume" | "cancel" | "decision";
  approvalId?: string;
  decision?: "approve" | "reject";
  text: string;
  attempted: boolean;
};
const TABS = ["Overview", "Tasks", "Task graph", "Agents", "Integration & review", "Events"].map(
  (label) => ({ value: label, label }),
);

export function SwarmRunDetail({
  runId,
  role,
  onBack,
}: {
  runId: string;
  role: SwarmRole;
  onBack: () => void;
}) {
  const query = useSwarmRun(runId);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("Overview");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const mutation = useMutation({
    mutationFn: async (command: Command) => {
      if (command.action === "decision" && command.approvalId && command.decision) {
        return api.decideSwarmApproval(runId, command.approvalId, {
          command_id: command.id,
          decision: command.decision,
          reason: command.text,
        });
      }
      if (command.action === "pause" || command.action === "resume" || command.action === "cancel")
        return api.controlSwarmRun(runId, command.action, command.id);
      throw new Error("Invalid command");
    },
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["swarm"] });
    },
  });
  const request = (
    input: Pick<Command, "action" | "label"> & Partial<Pick<Command, "approvalId" | "decision">>,
  ) => {
    mutation.reset();
    setPending({ ...input, id: randomUUID(), text: "", attempted: false });
  };
  const snapshot = query.data;
  if (!snapshot)
    return (
      <Card>
        <Button variant="ghost" onClick={onBack}>
          Back to runs
        </Button>
        <p role={query.isError ? "alert" : "status"}>
          {query.isError ? "Runtime unavailable. Retrying connection…" : "Loading Swarm run…"}
        </p>
      </Card>
    );
  const { run, tasks, agents, artifacts, approvals } = snapshot;
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  const canControl = role !== "viewer" && !query.stale && !terminal;
  const requiresText = pending?.action === "decision";
  const elapsed = run.started_at
    ? Math.max(
        0,
        Math.round(
          ((run.finished_at
            ? Date.parse(run.finished_at)
            : (query.lastSyncedAt ?? Date.parse(run.updated_at ?? run.created_at))) -
            Date.parse(run.started_at)) /
            60000,
        ),
      )
    : null;
  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase());
  return (
    <section className="space-y-4" aria-label="Swarm run">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back to runs
        </Button>
        <span className="text-xs text-muted-foreground">
          Role: {role} · Last sync:{" "}
          {query.lastSyncedAt ? new Date(query.lastSyncedAt).toLocaleTimeString() : "never"}
        </span>
      </div>
      {query.stale && (
        <Card role="alert" className="border-destructive text-destructive">
          Stale state — Runtime connection is unavailable or reconnecting. Controls are disabled.
        </Card>
      )}
      {query.historyGap && (
        <Card role="status">
          Older events are unavailable. State was reconciled from the Runtime snapshot.
        </Card>
      )}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{run.goal}</h2>
          <Badge>{run.status}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
          <div>
            <dt className="text-muted-foreground">Agents</dt>
            <dd>
              {run.active_agents} / {run.agent_limit}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tasks</dt>
            <dd>
              {run.completed_tasks} / {run.total_tasks}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Elapsed</dt>
            <dd>{elapsed === null ? "Not started" : `${elapsed}m`}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tokens</dt>
            <dd>{run.token_total.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Token budget</dt>
            <dd>{run.budget_tokens.toLocaleString()}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Sandbox: {run.sandbox} · Approval policy: {run.policy} · Created:{" "}
          {new Date(run.created_at).toLocaleString()}
        </p>
        {run.blockers.map((blocker, index) => (
          <p key={index} className="text-sm text-destructive">
            {blocker}
          </p>
        ))}
        {role !== "viewer" && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canControl || !["queued", "running", "verifying"].includes(run.status)}
              onClick={() => request({ action: "pause", label: "Pause" })}
            >
              Pause
            </Button>
            <Button
              size="sm"
              disabled={!canControl || !["paused", "needs_attention"].includes(run.status)}
              onClick={() => request({ action: "resume", label: "Resume" })}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!canControl}
              onClick={() => request({ action: "cancel", label: "Cancel run" })}
            >
              Cancel run
            </Button>
          </div>
        )}
      </Card>
      <Tabs
        items={TABS}
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setFilter("");
          setExpanded(null);
        }}
      />
      {tab === "Overview" && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Global acceptance criteria</h3>
          <ul className="list-inside list-disc text-sm">
            {run.acceptance_criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
          <p className="text-sm">
            Integration: {tasks.filter((task) => task.status === "submitted").length} pending ·{" "}
            {tasks.filter((task) => task.status === "verifying").length} in progress ·{" "}
            {artifacts.filter((artifact) => artifact.conflicts.length).length} with conflicts ·{" "}
            {approvals.filter((approval) => approval.status === "pending").length} approvals
          </p>
          <p className="text-xs text-muted-foreground">
            Runtime determines completion after global verification and integration.
          </p>
          <p className="text-xs">
            Last event: {query.events.at(-1)?.type ?? run.last_event?.type ?? "No recent events"}
          </p>
          <p className="text-xs">
            Integrated:{" "}
            {run.total_tasks ? Math.round((run.completed_tasks / run.total_tasks) * 100) : 0}% ·
            Tokens per integrated task:{" "}
            {run.completed_tasks
              ? Math.round(run.token_total / run.completed_tasks).toLocaleString()
              : "Unknown"}{" "}
            · Cost per integrated task:{" "}
            {run.completed_tasks && run.cost_usd !== null
              ? `$${(run.cost_usd / run.completed_tasks).toFixed(2)}`
              : "Unknown"}
          </p>
        </Card>
      )}
      {tab === "Task graph" && <SwarmTaskGraph tasks={tasks} />}
      {["Tasks", "Agents", "Events"].includes(tab) && (
        <Input
          aria-label={`Filter ${tab.toLowerCase()}`}
          placeholder="Filter by ID, status, task, agent or event"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      {tab === "Tasks" && (
        <div className="space-y-2">
          {tasks
            .filter((task) => matches(`${task.id} ${task.title} ${task.status} ${task.agent_id}`))
            .slice(0, 200)
            .map((task) => (
              <Card key={task.id} className="space-y-2 text-sm">
                <p>
                  <strong>{task.title}</strong> · {task.status} · {task.agent_id ?? "unassigned"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {task.id} · Parent: {task.parent_id ?? "none"} · Depends on:{" "}
                  {task.depends_on.join(", ") || "none"} ·{" "}
                  {task.duration_ms === null
                    ? "Duration unknown"
                    : `${Math.round(task.duration_ms / 1000)}s`}
                </p>
                {task.blocked_reason && <p className="text-destructive">{task.blocked_reason}</p>}
                <p>{task.result ?? "No result yet"}</p>
                <p className="break-all">Git: {task.git_ref ?? "No ref yet"}</p>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {task.tests.join("\n") || "No test results yet"}
                </pre>
              </Card>
            ))}
          <p className="text-xs text-muted-foreground">
            {tasks.length} tasks total · Up to 200 matching tasks shown.
          </p>
        </div>
      )}
      {tab === "Agents" && (
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <caption className="p-3 text-left text-muted-foreground">
              Agents — select details for task history and redacted logs
            </caption>
            <thead>
              <tr>
                {[
                  "Agent / role",
                  "Provider / model",
                  "Task / status",
                  "Heartbeat",
                  "Tokens / logs",
                ].map((label) => (
                  <th key={label} className="border-b border-border p-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents
                .filter((agent) =>
                  matches(`${agent.id} ${agent.role} ${agent.task_id} ${agent.status}`),
                )
                .map((agent) => (
                  <tr key={agent.id}>
                    <td className="border-b border-border p-3">
                      {agent.id} / {agent.role}
                    </td>
                    <td className="border-b border-border p-3">
                      {agent.provider} / {agent.model}
                    </td>
                    <td className="border-b border-border p-3">
                      {agent.task_id ?? "idle"} / {agent.status}
                    </td>
                    <td className="border-b border-border p-3">
                      {agent.heartbeat_at
                        ? new Date(agent.heartbeat_at).toLocaleTimeString()
                        : "Unknown"}
                    </td>
                    <td className="border-b border-border p-3">
                      {agent.token_total.toLocaleString()}
                      <Collapsible
                        open={expanded === agent.id}
                        onOpenChange={(open) => setExpanded(open ? agent.id : null)}
                        trigger="Details"
                      >
                        <p className="my-2">
                          Task history: {agent.task_history.join(", ") || "None"}
                        </p>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                          {agent.logs.join("\n") || "No logs yet"}
                        </pre>
                      </Collapsible>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "Integration & review" && (
        <div className="space-y-3">
          {artifacts.map((artifact) => (
            <Card key={artifact.id} className="space-y-2 text-sm">
              <h3 className="font-semibold">
                {artifact.title} · {artifact.status}
              </h3>
              <p className="break-all">
                Git: {artifact.git_ref ?? "No ref"} · Task: {artifact.task_id ?? "run"}
              </p>
              <p>
                CI: {artifact.ci_status ?? "Unknown"} · Review: {artifact.review ?? "Pending"}
              </p>
              <pre className="whitespace-pre-wrap break-words text-xs">
                {artifact.tests.join("\n") || "No test results"}
              </pre>
              {artifact.conflicts.map((conflict, index) => (
                <p key={index} className="text-destructive">
                  {conflict}
                </p>
              ))}
              <Collapsible
                open={expanded === artifact.id}
                onOpenChange={(open) => setExpanded(open ? artifact.id : null)}
                trigger="Open diff"
              >
                <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {artifact.diff ?? "Diff unavailable"}
                </pre>
              </Collapsible>
            </Card>
          ))}
          <h3 className="font-semibold">Approvals</h3>
          {approvals.map((approval) => (
            <Card key={approval.id} className="space-y-3 text-sm">
              <p>
                {approval.summary} · {approval.kind} · {approval.status}
              </p>
              <p className="text-xs text-muted-foreground">
                Artifact: {approval.artifact_id ?? "Run action"}
              </p>
              {role === "owner" && approval.status === "pending" && (
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["approve", "Approve"],
                      ["reject", "Reject"],
                    ] as const
                  ).map(([decision, label]) => (
                    <Button
                      key={decision}
                      size="sm"
                      variant="outline"
                      disabled={query.stale}
                      onClick={() =>
                        request({ action: "decision", label, approvalId: approval.id, decision })
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </Card>
          ))}
          {!artifacts.length && !approvals.length && (
            <p className="text-sm text-muted-foreground">
              No integration artifacts or approvals yet.
            </p>
          )}
        </div>
      )}
      {tab === "Events" && (
        <div className="max-h-[36rem] space-y-2 overflow-auto">
          {query.events
            .filter((event) =>
              matches(`${event.type} ${event.task_id} ${event.agent_id} ${event.actor.id}`),
            )
            .map((event) => (
              <Card key={event.event_id} className="space-y-2 text-xs">
                <p>
                  #{event.sequence} · {new Date(event.timestamp).toLocaleTimeString()} ·{" "}
                  <strong>{event.type}</strong> · {event.actor.role}
                </p>
                <p>
                  Task: {event.task_id ?? "—"} · Agent: {event.agent_id ?? "—"}
                </p>
                <pre className="whitespace-pre-wrap break-words">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </Card>
            ))}
          {!query.events.length && (
            <p className="text-sm text-muted-foreground">No recent events.</p>
          )}
        </div>
      )}
      <FormDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPending(null);
        }}
        title={`Confirm: ${pending?.label ?? "command"}`}
        error={
          mutation.isError
            ? "Command outcome is unconfirmed. Retry with the same command ID after reconnecting."
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" disabled={mutation.isPending} onClick={() => setPending(null)}>
              Back
            </Button>
            <Button
              disabled={
                query.stale || mutation.isPending || Boolean(requiresText && !pending?.text.trim())
              }
              onClick={() => {
                if (pending) {
                  const attempted = { ...pending, attempted: true };
                  setPending(attempted);
                  mutation.mutate(attempted);
                }
              }}
            >
              {mutation.isPending
                ? "Sending…"
                : mutation.isError
                  ? "Retry command"
                  : `Confirm ${pending?.label ?? "command"}`}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          This sends an audited command to Runtime. In-flight work and restricted actions follow
          Runtime policy.
        </p>
        {requiresText && (
          <Textarea
            aria-label="Decision reason"
            placeholder="Reason for this decision"
            value={pending?.text ?? ""}
            maxLength={2000}
            disabled={pending?.attempted}
            onChange={(event) =>
              setPending((current) => (current ? { ...current, text: event.target.value } : null))
            }
          />
        )}
      </FormDialog>
    </section>
  );
}
