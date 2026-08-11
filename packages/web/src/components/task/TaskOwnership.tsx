import { useState } from "react";
import type {
  ExecutionOwner,
  ParticipantSummary,
  Task,
  TaskAssigneeSummary,
  TaskEvent,
} from "@aif/shared/browser";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { useParticipants } from "@/hooks/useParticipants";
import { useHandoffTask } from "@/hooks/useTasks";
import { AlertBox } from "@/components/ui/alert-box";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Radio } from "@/components/ui/radio";
import { Textarea } from "@/components/ui/textarea";

interface TaskOwnershipSummaryProps {
  executionOwner: ExecutionOwner;
  assignees: TaskAssigneeSummary[];
  compact?: boolean;
}

export function TaskOwnershipSummary({
  executionOwner,
  assignees,
  compact = false,
}: TaskOwnershipSummaryProps) {
  const names = assignees.map(
    (assignee) => `${assignee.displayName}${assignee.active ? "" : " (inactive)"}`,
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge
        size={compact ? "xs" : "sm"}
        className={
          executionOwner === "ai"
            ? "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300"
            : "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
        }
      >
        {executionOwner === "ai" ? "AI owner" : "Human owner"}
      </Badge>
      {executionOwner === "human" && (
        <span className={`${compact ? "text-3xs" : "text-xs"} truncate text-muted-foreground`}>
          {names.length > 0 ? names.join(", ") : "Unassigned"}
        </span>
      )}
    </div>
  );
}

interface OwnershipFieldsProps {
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  participants: ParticipantSummary[];
  onExecutionOwnerChange: (owner: ExecutionOwner) => void;
  onAssigneeIdsChange: (ids: string[]) => void;
  allowMultiple?: boolean;
}

export function OwnershipFields({
  executionOwner,
  assigneeIds,
  participants,
  onExecutionOwnerChange,
  onAssigneeIdsChange,
  allowMultiple = true,
}: OwnershipFieldsProps) {
  const setOwner = (owner: ExecutionOwner) => {
    onExecutionOwnerChange(owner);
    if (owner === "ai") onAssigneeIdsChange([]);
  };

  const toggleAssignee = (participantId: string, checked: boolean) => {
    if (!checked) {
      onAssigneeIdsChange(assigneeIds.filter((id) => id !== participantId));
      return;
    }
    onAssigneeIdsChange(
      allowMultiple ? [...new Set([...assigneeIds, participantId])] : [participantId],
    );
  };

  return (
    <div className="space-y-2 border border-border/60 bg-muted/20 p-2">
      <div>
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Execution owner
        </p>
        <p className="text-3xs text-muted-foreground">
          Ownership selects who executes the task; Auto mode controls AI approval gates separately.
        </p>
      </div>
      <div className="flex gap-4">
        {(["ai", "human"] as const).map((owner) => (
          <label key={owner} className="flex items-center gap-1.5 text-xs text-foreground">
            <Radio
              name="executionOwner"
              checked={executionOwner === owner}
              onChange={() => setOwner(owner)}
              className="h-3.5 w-3.5"
            />
            {owner === "ai" ? "AI" : "Human"}
          </label>
        ))}
      </div>
      {executionOwner === "human" && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Assignees
          </p>
          {participants.length === 0 ? (
            <p className="text-xs text-muted-foreground">Leave unassigned</p>
          ) : (
            participants.map((participant) => (
              <label
                key={participant.id}
                className="flex items-center gap-2 text-xs text-foreground"
              >
                <Checkbox
                  checked={assigneeIds.includes(participant.id)}
                  onChange={(event) => toggleAssignee(participant.id, event.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <span>{participant.displayName}</span>
                <span className="text-3xs uppercase text-muted-foreground">{participant.role}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function conflictMessage(error: unknown): string {
  if (!(error instanceof ApiError) || typeof error.data !== "object" || error.data === null) {
    return error instanceof Error ? error.message : "Task handoff failed";
  }
  const code = "code" in error.data ? String(error.data.code) : "";
  return (
    {
      task_locked: "AI is currently working on this task. Try again after the active lease ends.",
      ownership_revision_conflict: "Ownership changed in another session. Refresh and try again.",
      inactive_assignee: "One or more selected participants are inactive.",
      invalid_ownership_transition: "This handoff is not valid from the current task stage.",
    }[code] ?? error.message
  );
}

type HandoffTask = Pick<
  Task,
  "id" | "executionOwner" | "ownershipRevision" | "assignees" | "status" | "autoMode"
>;

function requiredResumeAction(
  task: HandoffTask,
  targetOwner: ExecutionOwner,
): TaskEvent | undefined {
  if (targetOwner !== "ai" || task.executionOwner !== "human") return undefined;
  if (task.status === "plan_ready" && !task.autoMode) return "start_implementation";
  if (task.status === "blocked_external") return "retry_from_blocked";
  return undefined;
}

interface HandoffDialogProps {
  task: HandoffTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HandoffDialog({ task, open, onOpenChange }: HandoffDialogProps) {
  if (!open) return null;
  return <OpenHandoffDialog task={task} open={open} onOpenChange={onOpenChange} />;
}

function OpenHandoffDialog({ task, open, onOpenChange }: HandoffDialogProps) {
  const { session } = useAuth();
  const isAdmin = session?.participant?.role === "admin";
  const { data: managedParticipants = [] } = useParticipants(open && isAdmin);
  const handoff = useHandoffTask();
  const [executionOwner, setExecutionOwner] = useState<ExecutionOwner>(task.executionOwner);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    task.assignees.map((assignee) => assignee.participantId),
  );
  const [reason, setReason] = useState("");

  const participants: ParticipantSummary[] = isAdmin
    ? managedParticipants.filter((participant) => participant.active)
    : session?.participant?.active
      ? [session.participant]
      : [];
  const resumeAction = requiredResumeAction(task, executionOwner);
  const unchanged =
    executionOwner === task.executionOwner &&
    [...assigneeIds].sort().join(":") ===
      task.assignees
        .map((assignee) => assignee.participantId)
        .sort()
        .join(":");

  const submit = () => {
    console.debug("[task-ownership] Submitting handoff", {
      taskId: task.id,
      executionOwner,
      assigneeCount: assigneeIds.length,
      ownershipRevision: task.ownershipRevision,
    });
    handoff.mutate(
      {
        id: task.id,
        input: {
          executionOwner,
          assigneeIds: executionOwner === "human" ? assigneeIds : [],
          expectedOwnershipRevision: task.ownershipRevision,
          expectedExecutionOwner: task.executionOwner,
          expectedStatus: task.status,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(resumeAction ? { resumeAction } : {}),
        },
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => {
          console.warn("[task-ownership] Handoff rejected", {
            taskId: task.id,
            message: conflictMessage(error),
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign or hand off task</DialogTitle>
        </DialogHeader>
        <OwnershipFields
          executionOwner={executionOwner}
          assigneeIds={assigneeIds}
          participants={participants}
          onExecutionOwnerChange={setExecutionOwner}
          onAssigneeIdsChange={setAssigneeIds}
          allowMultiple={isAdmin}
        />
        {resumeAction && (
          <AlertBox variant="info" className="mt-3 text-xs">
            Resume action:{" "}
            {resumeAction === "retry_from_blocked" ? "Retry blocked work" : "Start implementation"}
          </AlertBox>
        )}
        <div className="mt-3 space-y-1">
          <label htmlFor="handoff-reason" className="text-xs text-muted-foreground">
            Reason (optional)
          </label>
          <Textarea
            id="handoff-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={2000}
          />
        </div>
        {handoff.isError && (
          <AlertBox variant="error" className="mt-3 text-xs">
            {conflictMessage(handoff.error)}
          </AlertBox>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={unchanged || handoff.isPending} onClick={submit}>
            {handoff.isPending ? "Saving..." : "Save ownership"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
