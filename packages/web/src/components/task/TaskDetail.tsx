import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import {
  HUMAN_ACTIONS_BY_STATUS,
  STATUS_CONFIG,
  type TaskCommentAttachment,
  type TaskEvent,
  type TaskStatus,
} from "@aif/shared/browser";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  useTask,
  useUpdateTask,
  useDeleteTask,
  useTaskEvent,
  useCreateTaskComment,
  useSyncTaskPlan,
} from "@/hooks/useTasks";
import { TaskDescription } from "./TaskDescription";
import { TaskPlan } from "./TaskPlan";
import { TaskLog } from "./TaskLog";
import { AgentTimeline } from "./AgentTimeline";
import { TaskComments } from "./TaskComments";

interface TaskDetailProps {
  taskId: string | null;
  onClose: () => void;
}

type TaskDetailTab = "implementation" | "review" | "comments" | "activity";
type PlanChangeMode = "replanning" | "fast_fix" | "request_changes";

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

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

export function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const { data: task } = useTask(taskId);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const taskEvent = useTaskEvent();
  const createTaskComment = useCreateTaskComment();
  const syncTaskPlan = useSyncTaskPlan();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showReplanModal, setShowReplanModal] = useState(false);
  const [planChangeMode, setPlanChangeMode] = useState<PlanChangeMode>("replanning");
  const [isSubmittingPlanChange, setIsSubmittingPlanChange] = useState(false);
  const [planChangeError, setPlanChangeError] = useState<string | null>(null);
  const [planChangeSuccess, setPlanChangeSuccess] = useState<string | null>(null);
  const [maintenanceSuccess, setMaintenanceSuccess] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [replanComment, setReplanComment] = useState("");
  const [replanFiles, setReplanFiles] = useState<File[]>([]);
  const [attachmentsDragOver, setAttachmentsDragOver] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("implementation");
  const taskAttachments = task?.attachments ?? [];

  const visibleActions = task
    ? (ACTION_BUTTONS_BY_STATUS[task.status] ?? []).filter(
        (action) => action.visible?.(task) ?? true
      )
    : [];

  const handleDelete = () => {
    if (!task) return;
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        onClose();
      },
    });
  };

  const resetReplanModal = () => {
    setShowReplanModal(false);
    setReplanComment("");
    setReplanFiles([]);
    setPlanChangeError(null);
    setIsSubmittingPlanChange(false);
  };

  const withTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  };

  const toAttachmentPayload = async (file: File): Promise<TaskCommentAttachment> => {
    const isTextLike =
      file.type.startsWith("text/") ||
      /\.(md|markdown|txt|json|ya?ml|toml|ini|env|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|css|scss|html|xml|csv|sql|sh)$/i.test(
        file.name
      );
    const isImage = file.type.startsWith("image/");
    const canReadContent = isTextLike && file.size <= 200_000;
    const rawContent = canReadContent ? await file.text() : null;
    let content: string | null = rawContent ? rawContent.slice(0, 200_000) : null;

    if (!content && isImage && file.size <= 1_000_000) {
      const base64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
      content = `data:${file.type || "application/octet-stream"};base64,${base64}`.slice(0, 2_000_000);
    }

    return {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      content,
    };
  };

  const handlePlanChangeRequest = async () => {
    if (!task) return;
    if (!replanComment.trim()) return;
    if (isSubmittingPlanChange) return;

    setIsSubmittingPlanChange(true);
    setPlanChangeError(null);
    try {
      const attachments = await Promise.all(replanFiles.map((file) => toAttachmentPayload(file)));
      await withTimeout(
        createTaskComment.mutateAsync({
          id: task.id,
          input: {
            message: replanComment.trim(),
            attachments,
          },
        }),
        30_000,
        "Comment request timed out"
      );
      await withTimeout(
        taskEvent.mutateAsync({
          id: task.id,
          event:
            planChangeMode === "replanning"
              ? "request_replanning"
              : planChangeMode === "fast_fix"
                ? "fast_fix"
                : "request_changes",
        }),
        planChangeMode === "fast_fix" ? 200_000 : 30_000,
        "Task event request timed out"
      );
      if (planChangeMode === "fast_fix") {
        setPlanChangeSuccess("Fast fix applied. Plan updated in task and sync to .ai-factory/PLAN.md attempted.");
      } else {
        setPlanChangeSuccess(null);
      }
      resetReplanModal();
      if (planChangeMode === "replanning" || planChangeMode === "request_changes") {
        onClose();
      }
    } catch (error) {
      console.error("[task-detail] failed to submit plan change request", error);
      setPlanChangeError(error instanceof Error ? error.message : "Failed to submit request");
    } finally {
      setIsSubmittingPlanChange(false);
    }
  };

  const handleTaskAttachmentsSelected = async (files: FileList | null) => {
    if (!task || !files || files.length === 0) return;
    const uploaded = await Promise.all(Array.from(files).map((file) => toAttachmentPayload(file)));
    updateTask.mutate({
      id: task.id,
      input: {
        attachments: [...taskAttachments, ...uploaded].slice(0, 10),
      },
    });
  };

  const handleRemoveTaskAttachment = (index: number) => {
    if (!task) return;
    updateTask.mutate({
      id: task.id,
      input: {
        attachments: taskAttachments.filter((_, i) => i !== index),
      },
    });
  };

  const handleTaskAttachmentsDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setAttachmentsDragOver(false);
    void handleTaskAttachmentsSelected(event.dataTransfer.files);
  };

  const handleClearActivityLog = () => {
    if (!task) return;
    const shouldClear = confirm("Clear agent activity log? This action cannot be undone.");
    if (!shouldClear) return;

    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    updateTask.mutate(
      {
        id: task.id,
        input: { agentActivityLog: null },
      },
      {
        onSuccess: () => {
          setMaintenanceSuccess("Agent activity log cleared.");
        },
        onError: (error) => {
          setMaintenanceError(error instanceof Error ? error.message : "Failed to clear agent activity log");
        },
      }
    );
  };

  const handleSyncPlanFromFile = () => {
    if (!task) return;
    const shouldSync = confirm("Sync plan from physical file into DB? Current DB plan will be overwritten.");
    if (!shouldSync) return;

    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    syncTaskPlan.mutate(task.id, {
      onSuccess: () => {
        setMaintenanceSuccess("Plan synced from physical file.");
      },
      onError: (error) => {
        setMaintenanceError(error instanceof Error ? error.message : "Failed to sync plan from physical file");
      },
    });
  };

  return (
    <>
      <Sheet open={!!taskId} onOpenChange={() => onClose()}>
        <SheetContent className="h-full w-full overflow-hidden p-0 md:w-[88vw] md:max-w-none">
          <SheetClose onClose={onClose} />

          {task && (
            <div className="flex h-full flex-col">
              <div className="border-b border-border p-6 pb-4 pr-14">
                <SheetHeader className="mb-3">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge
                      className="text-[10px]"
                      style={{
                        backgroundColor: STATUS_CONFIG[task.status].color + "20",
                        color: STATUS_CONFIG[task.status].color,
                        borderColor: STATUS_CONFIG[task.status].color + "40",
                      }}
                    >
                      {STATUS_CONFIG[task.status].label}
                    </Badge>
                    {task.priority > 0 && (
                      <Badge variant="outline" className="text-[10px]">
                        P{task.priority}
                      </Badge>
                    )}
                    <span className="ml-auto max-w-[52%] truncate font-mono text-[10px] text-muted-foreground">
                      {task.id}
                    </span>
                  </div>
                  <SheetTitle className="tracking-tight">{task.title}</SheetTitle>
                </SheetHeader>

                {HUMAN_ACTIONS_BY_STATUS[task.status].length > 0 && visibleActions.length > 0 && (
                  <div className="border border-border bg-background/60 p-3">
                    <label className="mb-2 block text-xs text-muted-foreground">
                      Actions
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {visibleActions.map((action) => (
                        <Button
                          key={action.event ?? action.label}
                          size="sm"
                          variant={action.variant}
                          onClick={() => {
                            if (action.actionType === "open_replanning") {
                              setPlanChangeMode("replanning");
                              setPlanChangeError(null);
                              setPlanChangeSuccess(null);
                              setShowReplanModal(true);
                              return;
                            }
                            if (action.actionType === "open_fast_fix") {
                              setPlanChangeMode("fast_fix");
                              setPlanChangeError(null);
                              setPlanChangeSuccess(null);
                              setShowReplanModal(true);
                              return;
                            }
                            if (action.actionType === "open_request_changes") {
                              setPlanChangeMode("request_changes");
                              setPlanChangeError(null);
                              setPlanChangeSuccess(null);
                              setShowReplanModal(true);
                              return;
                            }
                            if (action.event) {
                              taskEvent.mutate({ id: task.id, event: action.event });
                              onClose();
                            }
                          }}
                          disabled={isSubmittingPlanChange}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                    {planChangeSuccess && (
                      <div className="mt-2 border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-300">
                        {planChangeSuccess}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2 border border-border bg-background/55 p-2">
                  <TabButton
                    active={activeTab === "implementation"}
                    onClick={() => setActiveTab("implementation")}
                  >
                    Implementation
                  </TabButton>
                  <TabButton
                    active={activeTab === "review"}
                    onClick={() => setActiveTab("review")}
                  >
                    Review
                  </TabButton>
                  <TabButton
                    active={activeTab === "comments"}
                    onClick={() => setActiveTab("comments")}
                  >
                    Comments
                  </TabButton>
                  <TabButton
                    active={activeTab === "activity"}
                    onClick={() => setActiveTab("activity")}
                  >
                    Activity
                  </TabButton>
                </div>
              </div>

              <div className="grid flex-1 gap-4 overflow-hidden p-4 md:grid-cols-2">
                <div className="space-y-4 overflow-y-auto pr-1">
                  <Section title="Description">
                    <TaskDescription
                      description={task.description}
                      onSave={(description) =>
                        updateTask.mutate({
                          id: task.id,
                          input: { description },
                        })
                      }
                    />
                  </Section>

                  <Section title="Attachments">
                    <div className="space-y-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setAttachmentsExpanded((prev) => !prev)}
                      >
                        {attachmentsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {attachmentsExpanded ? "Hide attachments" : `Show attachments (${taskAttachments.length})`}
                      </button>

                      {attachmentsExpanded && (
                        <>
                          <div
                            className={`border border-dashed p-3 text-center text-xs transition-colors ${
                              attachmentsDragOver
                                ? "border-primary/60 bg-primary/10 text-primary"
                                : "border-border bg-secondary/20 text-muted-foreground"
                            }`}
                            onDragOver={(event) => {
                              event.preventDefault();
                              setAttachmentsDragOver(true);
                            }}
                            onDragLeave={() => setAttachmentsDragOver(false)}
                            onDrop={handleTaskAttachmentsDrop}
                          >
                            Drag files here to attach
                          </div>
                          <input
                            type="file"
                            multiple
                            onChange={(e) => {
                              void handleTaskAttachmentsSelected(e.target.files);
                              e.currentTarget.value = "";
                            }}
                            className="block w-full text-xs text-muted-foreground file:mr-3 file:border file:border-border file:bg-secondary/40 file:px-3 file:py-1.5 file:text-xs"
                          />
                          {taskAttachments.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No files attached to this task.</p>
                          ) : (
                            <ul className="space-y-1 text-xs text-foreground/85">
                              {taskAttachments.map((file, index) => (
                                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 border border-border bg-secondary/30 px-2 py-1.5">
                                  <span className="truncate">
                                    {file.name} ({file.mimeType || "unknown"}, {file.size} bytes)
                                    {file.content == null && (
                                      <span className="ml-1 text-[10px] text-muted-foreground">(metadata only)</span>
                                    )}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() => handleRemoveTaskAttachment(index)}
                                  >
                                    Remove
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  </Section>

                  <Section
                    title="Plan"
                    actions={(
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={handleSyncPlanFromFile}
                        disabled={syncTaskPlan.isPending}
                      >
                        {syncTaskPlan.isPending ? "Syncing..." : "Sync"}
                      </Button>
                    )}
                  >
                    <TaskPlan plan={task.plan} />
                  </Section>

                  <div className="border-t border-border pt-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      <Trash2 className="mr-1 h-3 w-3" /> Delete task
                    </Button>
                  </div>
                </div>

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

                  {activeTab === "activity" && (
                    <Section
                      title="Agent Activity"
                      actions={(
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={handleClearActivityLog}
                          disabled={updateTask.isPending}
                        >
                          {updateTask.isPending ? "Clearing..." : "Clear log"}
                        </Button>
                      )}
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

      {maintenanceSuccess && (
        <div className="fixed bottom-4 left-4 z-[70] border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {maintenanceSuccess}
        </div>
      )}
      {maintenanceError && (
        <div className="fixed bottom-4 right-4 z-[70] border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {maintenanceError}
        </div>
      )}

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This action cannot be undone. The task &ldquo;{task?.title}&rdquo;
            will be permanently deleted.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showReplanModal}
        onOpenChange={(open) => {
          if (isSubmittingPlanChange) return;
          if (!open) {
            resetReplanModal();
            return;
          }
          setShowReplanModal(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {planChangeMode === "replanning"
                ? "Request Replanning"
                : planChangeMode === "fast_fix"
                  ? "Fast Fix"
                  : "Request Changes"}
            </DialogTitle>
          </DialogHeader>
          <p className="mb-3 text-sm text-muted-foreground">
            {planChangeMode === "replanning"
              ? "Explain what should change in the plan. Your message and file metadata will be added to task comments."
              : planChangeMode === "fast_fix"
                ? "Describe a small change to the current plan. Your message and file metadata will be added to task comments."
                : "Describe what should be changed in the implementation. Your message and file metadata will be added to task comments."}
          </p>
          <div className="space-y-3">
            <Textarea
              value={replanComment}
              onChange={(e) => setReplanComment(e.target.value)}
              disabled={isSubmittingPlanChange}
              placeholder={
                planChangeMode === "replanning"
                  ? "Describe what needs to be changed in the plan..."
                  : planChangeMode === "fast_fix"
                    ? "Describe the quick plan fix..."
                    : "Describe what needs to be changed..."
              }
              rows={6}
            />
            <div className="space-y-2">
              <input
                type="file"
                multiple
                disabled={isSubmittingPlanChange}
                onChange={(e) => setReplanFiles(Array.from(e.target.files ?? []))}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:border file:border-border file:bg-secondary/40 file:px-3 file:py-1.5 file:text-xs"
              />
              {replanFiles.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {replanFiles.map((file) => (
                    <li key={`${file.name}-${file.size}`}>{file.name} ({file.size} bytes)</li>
                  ))}
                </ul>
              )}
            </div>
            {isSubmittingPlanChange && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {planChangeMode === "fast_fix"
                  ? "Applying fast fix to current plan..."
                  : planChangeMode === "replanning"
                    ? "Submitting replanning request..."
                    : "Submitting request changes..."}
              </div>
            )}
            {planChangeError && (
              <div className="border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {planChangeError}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={resetReplanModal}
              disabled={isSubmittingPlanChange}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handlePlanChangeRequest}
              disabled={
                !replanComment.trim() ||
                isSubmittingPlanChange
              }
            >
              {isSubmittingPlanChange
                ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Sending...
                  </>
                )
                : planChangeMode === "replanning"
                  ? "Send"
                  : planChangeMode === "fast_fix"
                    ? "Apply fast fix"
                    : "Request changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-background/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h4>
        {actions}
      </div>
      {children}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`border px-2 py-1 text-[10px] transition-colors ${
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border bg-background/50 text-muted-foreground hover:bg-background"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
