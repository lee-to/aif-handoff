import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTask, useRunQa } from "@/hooks/useTasks";
import { useQaPipelineEnabled } from "@/hooks/useSettings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TaskDescription } from "./TaskDescription";
import { TaskPlan } from "./TaskPlan";
import { TaskLog } from "./TaskLog";
import { AgentTimeline } from "./AgentTimeline";
import { TaskComments } from "./TaskComments";
import { TaskQA } from "./TaskQA";
import { TaskAttachments } from "./TaskAttachments";
import { TaskSettings } from "./TaskSettings";
import { PlanChangeDialog } from "./PlanChangeDialog";
import { TaskDetailHeader, type TaskDetailTab } from "./TaskDetailHeader";
import { Section } from "./Section";
import { useTaskDetailActions } from "./useTaskDetailActions";
import { AlertBox } from "@/components/ui/alert-box";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { HandoffDialog } from "./TaskOwnership";
import { ExecutorTimeline } from "./ExecutorTimeline";

interface TaskDetailProps {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const { data: task } = useTask(taskId);
  const [selectedTab, setSelectedTab] = useState<TaskDetailTab | null>(null);
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  const actions = useTaskDetailActions(task, onClose);
  const runQaMutation = useRunQa(taskId ?? "");
  const qaPipelineEnabled = useQaPipelineEnabled();
  const defaultTab: TaskDetailTab = (() => {
    if (!task) return "implementation";
    if (task.status === "review") return "review";
    if (task.implementationLog?.trim()) return "implementation";
    if (task.agentActivityLog?.trim()) return "activity";
    return "implementation";
  })();
  const activeTab: TaskDetailTab = selectedTab ?? defaultTab;

  return (
    <>
      <Sheet open={!!taskId} onOpenChange={() => onClose()}>
        <SheetContent className="w-full overflow-hidden p-0 md:w-[88vw] md:max-w-none">
          {task && (
            <div className="flex h-full flex-col">
              <TaskDetailHeader
                task={task}
                activeTab={activeTab}
                onTabChange={setSelectedTab}
                onActionClick={actions.handleActionClick}
                onTogglePaused={() =>
                  actions.updateTask.mutate({ id: task.id, input: { paused: !task.paused } })
                }
                isDisabled={actions.isSubmittingPlanChange}
                isCheckingStartAi={actions.isCheckingStartAiPlanFile}
                planChangeSuccess={actions.planChangeSuccess}
                onOpenHandoff={() => setShowHandoffDialog(true)}
                onClose={onClose}
              />

              {task.manualReviewRequired && (
                <div className="px-4 pt-4">
                  <AlertBox variant="warning" className="text-xs">
                    Auto-review stopped and human review is required. Inspect the review comments,
                    then use Approve or Request changes to resolve the task.
                  </AlertBox>
                </div>
              )}

              <div className="grid flex-1 gap-4 overflow-hidden p-4 md:grid-cols-2">
                {/* Left column */}
                <div className="space-y-4 overflow-y-auto pr-1">
                  <Section title="Description">
                    <TaskDescription
                      description={task.description}
                      readOnly={Boolean(task.github)}
                      onSave={(description) =>
                        actions.updateTask.mutate({ id: task.id, input: { description } })
                      }
                    />
                  </Section>

                  {task.github && (
                    <Section title="GitHub">
                      <div className="space-y-2 text-sm">
                        <a
                          href={task.github.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          Issue #{task.github.issueNumber}
                        </a>
                        {task.github.prUrl && (
                          <div>
                            <a
                              href={task.github.prUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary underline underline-offset-2"
                            >
                              Pull request #{task.github.prNumber}
                            </a>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" size="sm">
                            issue: {task.github.state}
                          </Badge>
                          {task.github.prState && (
                            <Badge variant="outline" size="sm">
                              PR: {task.github.prState}
                            </Badge>
                          )}
                          {task.github.prChecksStatus && (
                            <Badge variant="outline" size="sm">
                              checks: {task.github.prChecksStatus}
                            </Badge>
                          )}
                          {task.github.reviewState && (
                            <Badge variant="outline" size="sm">
                              review: {task.github.reviewState}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </Section>
                  )}

                  <Section title="Attachments">
                    <TaskAttachments
                      taskId={task.id}
                      attachments={task.attachments ?? []}
                      onFilesSelected={(files) => void actions.handleTaskAttachmentsSelected(files)}
                      onRemove={actions.handleRemoveTaskAttachment}
                    />
                  </Section>

                  {task.worktreePath && (
                    <Section title="Worktree">
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground break-all">
                        {task.worktreePath}
                      </div>
                    </Section>
                  )}

                  {(task.status === "backlog" || task.status === "done") && (
                    <TaskSettings
                      task={task}
                      onSave={(input) => actions.updateTask.mutate({ id: task.id, input })}
                    />
                  )}

                  <Section
                    title="Plan"
                    actions={
                      task.plan?.trim() ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => actions.setShowSyncPlanConfirm(true)}
                          disabled={actions.syncTaskPlanIsPending}
                        >
                          {actions.syncTaskPlanIsPending ? "Syncing..." : "Sync"}
                        </Button>
                      ) : undefined
                    }
                  >
                    <TaskPlan plan={task.plan} />
                  </Section>

                  <div className="border-t border-border pt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => actions.setShowDeleteConfirm(true)}
                    >
                      <Trash2 className="mr-1 h-3 w-3" /> Delete task
                    </Button>
                  </div>
                </div>

                {/* Right column */}
                <div className="space-y-4 overflow-y-auto pr-1">
                  {activeTab === "implementation" && (
                    <Section title="Implementation Log">
                      <TaskLog log={task.implementationLog} label="Implementation log" />
                    </Section>
                  )}
                  {activeTab === "review" && (
                    <Section title="Review Comments">
                      <TaskLog log={task.reviewComments} label="Review comments" />
                    </Section>
                  )}
                  {activeTab === "comments" && (
                    <Section title="Comments">
                      <TaskComments taskId={task.id} />
                    </Section>
                  )}
                  {activeTab === "executors" && (
                    <Section title="Executor history">
                      <ExecutorTimeline taskId={task.id} />
                    </Section>
                  )}
                  {qaPipelineEnabled && activeTab === "qa" && (
                    <TaskQA
                      task={task}
                      onRunQa={() => runQaMutation.mutate()}
                      isRunning={task.qaStatus === "running"}
                    />
                  )}
                  {activeTab === "activity" && (
                    <Section
                      title="Agent Activity"
                      actions={
                        task.agentActivityLog?.trim() ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => actions.setShowClearActivityConfirm(true)}
                            disabled={actions.updateTaskIsPending}
                          >
                            {actions.updateTaskIsPending ? "Clearing..." : "Clear log"}
                          </Button>
                        ) : undefined
                      }
                    >
                      <AgentTimeline activityLog={task.agentActivityLog} />
                    </Section>
                  )}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Toast notifications */}
      {actions.maintenanceSuccess && (
        <AlertBox
          variant="success"
          className="fixed bottom-4 left-4 text-xs"
          style={{ zIndex: "var(--z-bubble)" }}
        >
          {actions.maintenanceSuccess}
        </AlertBox>
      )}
      {actions.maintenanceError && (
        <AlertBox
          variant="error"
          className="fixed bottom-4 right-4 text-xs"
          style={{ zIndex: "var(--z-bubble)" }}
        >
          {actions.maintenanceError}
        </AlertBox>
      )}

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={actions.showDeleteConfirm}
        onOpenChange={actions.setShowDeleteConfirm}
        title="Delete task?"
        description={`This action cannot be undone. The task "${task?.title ?? ""}" will be permanently deleted.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={actions.handleDelete}
      />
      <ConfirmDialog
        open={actions.showClearActivityConfirm}
        onOpenChange={actions.setShowClearActivityConfirm}
        title="Clear agent activity log?"
        description="This action cannot be undone. All agent activity entries for this task will be removed."
        confirmLabel={actions.updateTaskIsPending ? "Clearing..." : "Clear"}
        variant="destructive"
        disabled={actions.updateTaskIsPending}
        onConfirm={actions.handleClearActivityLog}
      />
      <ConfirmDialog
        open={actions.showSyncPlanConfirm}
        onOpenChange={actions.setShowSyncPlanConfirm}
        title="Sync plan from file?"
        description="This will overwrite the current plan in DB with the content from the physical plan file."
        confirmLabel={actions.syncTaskPlanIsPending ? "Syncing..." : "Sync"}
        disabled={actions.syncTaskPlanIsPending}
        onConfirm={actions.handleSyncPlanFromFile}
      />
      <Dialog open={actions.showStartAiConfirm} onOpenChange={actions.setShowStartAiConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan file already exists</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A plan file already exists
            {actions.startAiPlanPath ? ` (${actions.startAiPlanPath})` : ""}.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <Button
              size="sm"
              onClick={() => {
                actions.setShowStartAiConfirm(false);
                actions.handleAcceptExistingPlan();
              }}
            >
              Use Existing Plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                actions.setShowStartAiConfirm(false);
                actions.triggerStartAi({ deletePlanFile: true });
              }}
            >
              Overwrite & Re-plan
            </Button>
            <Button variant="ghost" size="sm" onClick={() => actions.setShowStartAiConfirm(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={actions.showApproveDoneConfirm}
        onOpenChange={(next) => {
          // Block dismissing the modal while a commit is in flight so the
          // user waits for the WS ack (commit_done / commit_failed).
          if (!next && actions.commitPending) return;
          actions.setShowApproveDoneConfirm(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve done task?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The task will move from <strong>Done</strong> to <strong>Verified</strong>.
          </p>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <Checkbox
              checked={actions.deletePlanOnApprove}
              onChange={(event) => actions.setDeletePlanOnApprove(event.target.checked)}
              disabled={actions.commitPending}
            />
            Delete plan file ({task?.isFix ? "FIX_PLAN.md" : "PLAN.md"})
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <Checkbox
              checked={actions.commitOnApprove}
              onChange={(event) => actions.setCommitOnApprove(event.target.checked)}
              disabled={actions.commitPending}
            />
            Create commit (/aif-commit)
          </label>
          {actions.commitPending && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size="sm" />
              <span>Running /aif-commit… waiting for server ack.</span>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={actions.commitPending}
              onClick={() => {
                actions.setShowApproveDoneConfirm(false);
                actions.setDeletePlanOnApprove(false);
                actions.setCommitOnApprove(true);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={actions.handleApproveDone} disabled={actions.commitPending}>
              {actions.commitPending ? (
                <span className="flex items-center gap-2">
                  <Spinner size="sm" />
                  Committing…
                </span>
              ) : (
                "Approve"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Plan change dialog */}
      <PlanChangeDialog
        open={actions.showReplanModal}
        mode={actions.planChangeMode}
        comment={actions.replanComment}
        onCommentChange={actions.setReplanComment}
        files={actions.replanFiles}
        onFilesChange={actions.setReplanFiles}
        isSubmitting={actions.isSubmittingPlanChange}
        error={actions.planChangeError}
        onSubmit={actions.handlePlanChangeRequest}
        onCancel={actions.resetReplanModal}
      />
      {task && (
        <HandoffDialog
          key={`${task.id}:${task.ownershipRevision}:${showHandoffDialog}`}
          task={task}
          open={showHandoffDialog}
          onOpenChange={setShowHandoffDialog}
        />
      )}
    </>
  );
}
