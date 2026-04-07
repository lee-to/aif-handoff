import { useEffect, useState } from "react";
import {
  withTimeout,
  type TaskCommentAttachment,
  type TaskEvent,
  type Task,
} from "@aif/shared/browser";
import { api } from "@/lib/api";
import { encodeBase64 } from "@/lib/formatters";
import {
  useUpdateTask,
  useDeleteTask,
  useTaskEvent,
  useCreateTaskComment,
  useSyncTaskPlan,
} from "@/hooks/useTasks";

export type PlanChangeMode = "replanning" | "fast_fix" | "request_changes";

const TEXT_FILE_MAX_SIZE = 200_000;
const IMAGE_FILE_MAX_SIZE = 1_000_000;
const BASE64_CONTENT_MAX_SIZE = 2_000_000;
const MAX_TASK_ATTACHMENTS = 10;
const COMMENT_TIMEOUT_MS = 30_000;
const FAST_FIX_TIMEOUT_MS = 200_000;

export async function toAttachmentPayload(file: File): Promise<TaskCommentAttachment> {
  const isTextLike =
    file.type.startsWith("text/") ||
    /\.(md|markdown|txt|json|ya?ml|toml|ini|env|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|css|scss|html|xml|csv|sql|sh)$/i.test(
      file.name,
    );
  const isImage = file.type.startsWith("image/");
  const canReadContent = isTextLike && file.size <= TEXT_FILE_MAX_SIZE;
  const rawContent = canReadContent ? await file.text() : null;
  let content: string | null = rawContent ? rawContent.slice(0, TEXT_FILE_MAX_SIZE) : null;

  if (!content && isImage && file.size <= IMAGE_FILE_MAX_SIZE) {
    const base64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
    content = `data:${file.type || "application/octet-stream"};base64,${base64}`.slice(
      0,
      BASE64_CONTENT_MAX_SIZE,
    );
  }

  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    content,
  };
}

export function useTaskDetailActions(task: Task | undefined, onClose: () => void) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const taskEvent = useTaskEvent();
  const createTaskComment = useCreateTaskComment();
  const syncTaskPlan = useSyncTaskPlan();

  // --- Delete ---
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = () => {
    if (!task) return;
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        onClose();
      },
    });
  };

  // --- Plan change (replanning / fast_fix / request_changes) ---
  const [showReplanModal, setShowReplanModal] = useState(false);
  const [planChangeMode, setPlanChangeMode] = useState<PlanChangeMode>("replanning");
  const [isSubmittingPlanChange, setIsSubmittingPlanChange] = useState(false);
  const [planChangeError, setPlanChangeError] = useState<string | null>(null);
  const [planChangeSuccess, setPlanChangeSuccess] = useState<string | null>(null);
  const [replanComment, setReplanComment] = useState("");
  const [replanFiles, setReplanFiles] = useState<File[]>([]);

  const resetReplanModal = () => {
    setShowReplanModal(false);
    setReplanComment("");
    setReplanFiles([]);
    setPlanChangeError(null);
    setIsSubmittingPlanChange(false);
  };

  const openPlanChange = (mode: PlanChangeMode) => {
    setPlanChangeMode(mode);
    setPlanChangeError(null);
    setPlanChangeSuccess(null);
    setShowReplanModal(true);
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
          input: { message: replanComment.trim(), attachments },
        }),
        COMMENT_TIMEOUT_MS,
        "Comment request timed out",
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
        planChangeMode === "fast_fix" ? FAST_FIX_TIMEOUT_MS : COMMENT_TIMEOUT_MS,
        "Task event request timed out",
      );
      if (planChangeMode === "fast_fix") {
        setPlanChangeSuccess(
          `Fast fix applied. Plan updated in task and sync to ${task.planPath || ".ai-factory/PLAN.md"} attempted.`,
        );
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

  // --- Maintenance (clear activity, sync plan) ---
  const [maintenanceSuccess, setMaintenanceSuccess] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [showClearActivityConfirm, setShowClearActivityConfirm] = useState(false);
  const [showSyncPlanConfirm, setShowSyncPlanConfirm] = useState(false);

  useEffect(() => {
    if (!maintenanceSuccess) return;
    const id = window.setTimeout(() => setMaintenanceSuccess(null), 4000);
    return () => window.clearTimeout(id);
  }, [maintenanceSuccess]);

  useEffect(() => {
    if (!maintenanceError) return;
    const id = window.setTimeout(() => setMaintenanceError(null), 4000);
    return () => window.clearTimeout(id);
  }, [maintenanceError]);

  const handleClearActivityLog = () => {
    if (!task) return;
    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    updateTask.mutate(
      { id: task.id, input: { agentActivityLog: null } },
      {
        onSuccess: () => {
          setShowClearActivityConfirm(false);
          setMaintenanceSuccess("Agent activity log cleared.");
        },
        onError: (error) => {
          setMaintenanceError(
            error instanceof Error ? error.message : "Failed to clear agent activity log",
          );
        },
      },
    );
  };

  const handleSyncPlanFromFile = () => {
    if (!task) return;
    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    syncTaskPlan.mutate(task.id, {
      onSuccess: () => {
        setShowSyncPlanConfirm(false);
        setMaintenanceSuccess("Plan synced from physical file.");
      },
      onError: (error) => {
        setMaintenanceError(
          error instanceof Error ? error.message : "Failed to sync plan from physical file",
        );
      },
    });
  };

  // --- Start AI with plan-file check ---
  const [showStartAiConfirm, setShowStartAiConfirm] = useState(false);
  const [startAiPlanPath, setStartAiPlanPath] = useState<string | null>(null);
  const [isCheckingStartAiPlanFile, setIsCheckingStartAiPlanFile] = useState(false);

  const triggerStartAi = (options?: { deletePlanFile?: boolean }) => {
    if (!task) return;
    taskEvent.mutate({ id: task.id, event: "start_ai", deletePlanFile: options?.deletePlanFile });
    onClose();
  };

  const handleAcceptExistingPlan = () => {
    if (!task) return;
    taskEvent.mutate({ id: task.id, event: "accept_existing_plan" });
    onClose();
  };

  const handleStartAiClick = async () => {
    if (!task) return;
    if (isCheckingStartAiPlanFile) return;
    setIsCheckingStartAiPlanFile(true);
    try {
      const status = await api.getTaskPlanFileStatus(task.id);
      if (status.exists) {
        setStartAiPlanPath(status.path);
        setShowStartAiConfirm(true);
        return;
      }
      triggerStartAi();
    } catch (error) {
      console.warn("[task-detail] failed to check plan file status before start_ai", error);
      triggerStartAi();
    } finally {
      setIsCheckingStartAiPlanFile(false);
    }
  };

  // --- Attachments ---
  const handleTaskAttachmentsSelected = async (files: FileList | null) => {
    if (!task || !files || files.length === 0) return;
    const uploaded = await Promise.all(Array.from(files).map((file) => toAttachmentPayload(file)));
    const taskAttachments = task.attachments ?? [];
    updateTask.mutate({
      id: task.id,
      input: { attachments: [...taskAttachments, ...uploaded].slice(0, MAX_TASK_ATTACHMENTS) },
    });
  };

  const handleRemoveTaskAttachment = (index: number) => {
    if (!task) return;
    const taskAttachments = task.attachments ?? [];
    updateTask.mutate({
      id: task.id,
      input: { attachments: taskAttachments.filter((_, i) => i !== index) },
    });
  };

  // --- Approve done confirm ---
  const [showApproveDoneConfirm, setShowApproveDoneConfirm] = useState(false);
  const [deletePlanOnApprove, setDeletePlanOnApprove] = useState(false);
  const [commitOnApprove, setCommitOnApprove] = useState(true);

  const handleApproveDone = () => {
    if (!task) return;
    taskEvent.mutate({
      id: task.id,
      event: "approve_done",
      deletePlanFile: deletePlanOnApprove,
      commitOnApprove,
    });
    setShowApproveDoneConfirm(false);
    setDeletePlanOnApprove(false);
    setCommitOnApprove(true);
    onClose();
  };

  // --- Action button dispatch ---
  const handleActionClick = (action: { event?: TaskEvent; actionType?: string }) => {
    if (action.actionType === "open_replanning") {
      openPlanChange("replanning");
      return;
    }
    if (action.actionType === "open_fast_fix") {
      openPlanChange("fast_fix");
      return;
    }
    if (action.actionType === "open_request_changes") {
      openPlanChange("request_changes");
      return;
    }
    if (action.event) {
      if (action.event === "start_ai") {
        void handleStartAiClick();
        return;
      }
      if (action.event === "approve_done") {
        setShowApproveDoneConfirm(true);
        return;
      }
      taskEvent.mutate({ id: task!.id, event: action.event });
      onClose();
    }
  };

  return {
    // delete
    showDeleteConfirm,
    setShowDeleteConfirm,
    handleDelete,
    // plan change
    showReplanModal,
    planChangeMode,
    isSubmittingPlanChange,
    planChangeError,
    planChangeSuccess,
    replanComment,
    setReplanComment,
    replanFiles,
    setReplanFiles,
    resetReplanModal,
    handlePlanChangeRequest,
    // maintenance
    maintenanceSuccess,
    maintenanceError,
    showClearActivityConfirm,
    setShowClearActivityConfirm,
    handleClearActivityLog,
    showSyncPlanConfirm,
    setShowSyncPlanConfirm,
    handleSyncPlanFromFile,
    syncTaskPlanIsPending: syncTaskPlan.isPending,
    updateTaskIsPending: updateTask.isPending,
    // start AI
    showStartAiConfirm,
    setShowStartAiConfirm,
    startAiPlanPath,
    isCheckingStartAiPlanFile,
    triggerStartAi,
    handleAcceptExistingPlan,
    // attachments
    handleTaskAttachmentsSelected,
    handleRemoveTaskAttachment,
    // approve done
    showApproveDoneConfirm,
    setShowApproveDoneConfirm,
    deletePlanOnApprove,
    setDeletePlanOnApprove,
    commitOnApprove,
    setCommitOnApprove,
    handleApproveDone,
    // action buttons
    handleActionClick,
    // update task (for description save)
    updateTask,
  };
}
