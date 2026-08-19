import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "@/hooks/useOutsideClick";
import {
  Send,
  Trash2,
  Bot,
  X,
  Plus,
  ClipboardList,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Square,
  ExternalLink,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { AttachmentChip } from "@/components/ui/attachment-chip";
import { useChat } from "@/hooks/useChat";
import { useChatSessions } from "@/hooks/useChatSessions";
import { useTask, useTasks } from "@/hooks/useTasks";
import { useThreadWorkspace } from "@/hooks/useThreadWorkspace";
import { useEffectiveChatRuntime, useRuntimeProfiles } from "@/hooks/useRuntimeProfiles";
import { useUsageLimitsEnabled } from "@/hooks/useSettings";
import {
  toAttachmentPayload,
  partitionBySize,
  ATTACHMENT_SIZE_HARD_LIMIT,
} from "@/components/task/useTaskDetailActions";
import { getRuntimeLimitDisplay } from "@/lib/runtimeLimits";
import { formatRuntimeProfileName } from "@/lib/runtimeProfiles";
import { readDroppedFiles, summarizeAttachments } from "@/lib/attachmentTransfer";
import { SessionList } from "./SessionList";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import type { ChatAttachment } from "@aif/shared/browser";

export const MAX_CHAT_ATTACHMENTS = 100;
const CHAT_ATTACHMENT_WARN_AT = 50;

interface ChatPanelProps {
  isOpen: boolean;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  embedded?: boolean;
  kerryPilotMode?: boolean;
}

export function ChatPanel({
  isOpen,
  projectId,
  projectName,
  taskId,
  onClose,
  onOpenTask,
  embedded = false,
  kerryPilotMode = false,
}: ChatPanelProps) {
  const [showSessions, setShowSessions] = useState(embedded);

  const {
    sessions,
    isLoading: isLoadingSessions,
    activeSessionId,
    setActiveSessionId,
    pinActiveSession,
    clearActiveSession,
    claimSession,
    isClaiming,
    claimError,
    deleteSession,
    renameSession,
  } = useChatSessions(projectId);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workspaceThreadId = activeSession?.source === "web" ? activeSession.id : null;
  const {
    workspace,
    error: workspaceError,
    createObjective,
    updateObjective,
    linkTask,
    unlinkTask,
    updateStatus,
  } = useThreadWorkspace(workspaceThreadId);
  const { data: projectTasks } = useTasks(projectId);

  const {
    messages,
    isStreaming,
    isLoadingMessages,
    chatErrorCode,
    chatRuntimeLimitSnapshot,
    explore,
    setExplore,
    sendMessage,
    abortStream,
    clearMessages,
    newSession,
  } = useChat(
    projectId,
    activeSessionId,
    taskId,
    setActiveSessionId,
    activeSession?.runtimeProfileId ?? null,
  );

  const { data: currentTask } = useTask(taskId);
  const { data: effectiveChatRuntime } = useEffectiveChatRuntime(projectId);
  const { data: runtimeProfiles } = useRuntimeProfiles(projectId, true);
  const [input, setInput] = useState("");
  const [objectiveTitle, setObjectiveTitle] = useState("");
  const [taskToLink, setTaskToLink] = useState("");
  const [taskObjectiveId, setTaskObjectiveId] = useState("");
  const [pendingFiles, setPendingFiles] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleTaskCreated = useCallback(() => {
    // Task created via action card — react-query invalidation happens in useCreateTask
  }, []);
  const panelRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
  }, [messages, isStreaming]);

  // Focus textarea when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => textareaRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Close chat on Escape key or outside click while open
  useOutsideClick(panelRef, onClose, isOpen && !embedded);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    pinActiveSession();
    const files = pendingFiles.length > 0 ? pendingFiles : undefined;
    void sendMessage(input, files, false);
    setInput("");
    setPendingFiles([]);
    setOversizeNotice([]);
  };

  const [oversizeNotice, setOversizeNotice] = useState<string[]>([]);

  const handleFilesSelected = async (input: FileList | File[]) => {
    const arr = Array.isArray(input) ? input : Array.from(input);
    const { accepted, rejected } = partitionBySize(arr);
    if (rejected.length > 0) {
      console.warn(
        "[chat] dropping %d files over %d bytes: %s",
        rejected.length,
        ATTACHMENT_SIZE_HARD_LIMIT,
        rejected.map((f) => f.name).join(", "),
      );
      setOversizeNotice(rejected.map((f) => f.name));
    } else {
      setOversizeNotice([]);
    }
    const remaining = MAX_CHAT_ATTACHMENTS - pendingFiles.length;
    if (remaining <= 0) return;
    const newFiles: ChatAttachment[] = [];
    for (const file of accepted.slice(0, remaining)) {
      const payload = await toAttachmentPayload(file);
      newFiles.push({
        name: payload.name,
        mimeType: payload.mimeType,
        size: payload.size,
        content: payload.content,
      });
    }
    setPendingFiles((prev) => [...prev, ...newFiles].slice(0, MAX_CHAT_ATTACHMENTS));
  };

  const [composerDragOver, setComposerDragOver] = useState(false);

  const handleComposerDragOver = (e: ReactDragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes("Files")) return;
    e.preventDefault();
    setComposerDragOver(true);
  };

  const handleComposerDragLeave = (e: ReactDragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setComposerDragOver(false);
  };

  const handleComposerDrop = (e: ReactDragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes("Files")) return;
    e.preventDefault();
    setComposerDragOver(false);
    void readDroppedFiles(e.dataTransfer).then((files) => {
      if (files.length > 0) void handleFilesSelected(files);
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = useCallback(() => {
    newSession();
    clearActiveSession();
    console.debug("[ChatPanel] New chat started");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [newSession, clearActiveSession]);

  const handleSessionSelect = useCallback(
    (id: string) => {
      console.debug("[ChatPanel] Session switched to %s", id);
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      console.debug("[SessionList] Deleting session %s", id);
      await deleteSession(id);
    },
    [deleteSession],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      console.debug("[SessionList] Renaming session %s to %s", id, title);
      await renameSession(id, title);
    },
    [renameSession],
  );

  const linkedTaskIds = new Set(workspace?.tasks.map((task) => task.taskId) ?? []);
  const availableTasks = projectTasks?.filter((task) => !linkedTaskIds.has(task.id)) ?? [];

  const handleAddObjective = async () => {
    const title = objectiveTitle.trim();
    if (!title) return;
    await createObjective({ title });
    setObjectiveTitle("");
  };

  const handleLinkTask = async () => {
    if (!taskToLink) return;
    await linkTask({ taskId: taskToLink, objectiveId: taskObjectiveId || null });
    setTaskToLink("");
    setTaskObjectiveId("");
  };

  const sessionProfileId = activeSession?.runtimeProfileId ?? null;

  // Show the session's own runtime when it has one, otherwise show the project effective runtime
  const sessionProfile = sessionProfileId
    ? runtimeProfiles?.find((p) => p.id === sessionProfileId)
    : null;
  const displayProfile = sessionProfile ?? effectiveChatRuntime?.profile ?? null;
  const activeRuntimeProfileName =
    (displayProfile ? formatRuntimeProfileName(displayProfile) : null) ??
    (effectiveChatRuntime?.source === "system_default"
      ? "App default"
      : effectiveChatRuntime?.source === "project_default"
        ? "Project default"
        : effectiveChatRuntime?.source === "none"
          ? "Env fallback"
          : "Unnamed profile");
  const activeRuntimeEngine = displayProfile
    ? `${displayProfile.runtimeId}/${displayProfile.providerId}`
    : effectiveChatRuntime?.resolved
      ? `${effectiveChatRuntime.resolved.runtimeId}/${effectiveChatRuntime.resolved.providerId}`
      : "n/a";
  const activeRuntimeModel =
    displayProfile?.defaultModel ?? effectiveChatRuntime?.resolved?.model ?? "auto";
  const usageLimitsEnabled = useUsageLimitsEnabled();
  const chatRuntimeLimitDisplay = usageLimitsEnabled
    ? getRuntimeLimitDisplay(
        chatRuntimeLimitSnapshot ?? displayProfile?.runtimeLimitSnapshot ?? null,
        {
          checkedAt:
            displayProfile?.runtimeLimitUpdatedAt ?? chatRuntimeLimitSnapshot?.checkedAt ?? null,
        },
      )
    : null;
  const chatRuntimeLimitTone = chatRuntimeLimitDisplay?.tone ?? "warning";
  const chatRuntimeLimitContainerClassName = cn(
    "mt-2 border px-2.5 py-2",
    chatRuntimeLimitTone === "warning" &&
      "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-200/90",
    chatRuntimeLimitTone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
    chatRuntimeLimitTone === "success" &&
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    chatRuntimeLimitTone === "info" && "border-border bg-card/60 text-foreground",
  );
  const chatRuntimeLimitLabel = chatRuntimeLimitDisplay
    ? chatRuntimeLimitDisplay.state === "expired"
      ? "Limit Window Expired"
      : chatRuntimeLimitDisplay.state === "signal_no_reset"
        ? "Limit Signal (No Reset)"
        : chatRuntimeLimitDisplay.state === "historical"
          ? "Historical Limit Signal"
          : chatRuntimeLimitDisplay.label === "Blocked"
            ? "Runtime Blocked"
            : chatRuntimeLimitDisplay.label === "Healthy"
              ? "Runtime Healthy"
              : "Runtime Near Limit"
    : "Usage Limit Reached";
  const chatRuntimeLimitSummary =
    chatRuntimeLimitDisplay?.summary ??
    "Runtime usage limit is currently exhausted. Wait for reset time and send again.";
  const chatRuntimeLimitMeta =
    chatRuntimeLimitDisplay &&
    [
      chatRuntimeLimitDisplay.resetText,
      chatRuntimeLimitDisplay.taskRetryText,
      chatRuntimeLimitDisplay.checkedText,
    ]
      .filter(Boolean)
      .join(" ");

  const content = (
    <div
      ref={panelRef}
      className={cn(
        "flex flex-col border-border bg-background",
        embedded
          ? "relative h-[calc(100vh-190px)] min-h-[620px] w-full border"
          : "fixed bottom-0 left-0 w-[800px] border-r transition-transform duration-300 ease-in-out",
        !embedded && (isOpen ? "translate-x-0" : "-translate-x-full"),
      )}
      style={embedded ? undefined : { top: "var(--header-height, 65px)", zIndex: "var(--z-chat)" }}
    >
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSessions((v) => !v)}
              className="h-7 w-7 border-0 text-muted-foreground"
              aria-label={showSessions ? "Hide sessions" : "Show sessions"}
            >
              {showSessions ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </Button>
            <Bot className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold truncate max-w-[300px]">
              {activeSession?.title ?? "New Thread"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleNewChat}
              className="h-7 w-7 border-0 text-muted-foreground"
              aria-label="New thread"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clearMessages}
              className="h-7 w-7 border-0 text-muted-foreground"
              aria-label="Clear messages"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            {!embedded && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7 border-0 text-muted-foreground"
                aria-label="Close chat"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        {currentTask && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClipboardList className="h-3 w-3" />
            <span className="truncate max-w-[90%]">
              Task: <span className="text-foreground font-medium">{currentTask.title}</span>
              <Badge variant="outline" size="sm" className="ml-1.5">
                {currentTask.status}
              </Badge>
            </span>
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>Project:</span>
          <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px] font-medium">
            {projectName ?? "No project"}
          </Badge>
          <span>Profile:</span>
          <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px] font-medium">
            {activeRuntimeProfileName}
          </Badge>
          <span>Runtime:</span>
          <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px] font-medium">
            {activeRuntimeEngine}
          </Badge>
          <span>Model:</span>
          <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px] font-medium">
            {activeRuntimeModel}
          </Badge>
        </div>
        {chatRuntimeLimitDisplay && (
          <div className={chatRuntimeLimitContainerClassName}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  "border-current/40",
                  chatRuntimeLimitTone === "info" && "text-foreground",
                )}
              >
                {chatRuntimeLimitLabel}
              </Badge>
              <span className="text-[11px] opacity-80">{activeRuntimeProfileName}</span>
            </div>
            <p className="mt-1 text-xs">{chatRuntimeLimitSummary}</p>
            {chatRuntimeLimitMeta && (
              <p className="mt-1 text-[11px] opacity-80">{chatRuntimeLimitMeta}</p>
            )}
          </div>
        )}
      </div>

      {activeSession?.source !== "web" && activeSession?.runtimeSessionId && (
        <div className="border-b border-border bg-secondary/20 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Track this existing chat with objectives, tasks, and pull requests.
            </p>
            <Button
              size="sm"
              disabled={isClaiming}
              onClick={() => void claimSession(activeSession).catch(() => undefined)}
            >
              {isClaiming ? "Adding..." : "Add objectives and tasks"}
            </Button>
          </div>
          {claimError && <p className="mt-2 text-xs text-destructive">{claimError}</p>}
        </div>
      )}

      {workspace && (
        <div className="border-b border-border bg-secondary/20 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide">Objectives</span>
            <select
              aria-label="Thread status"
              value={workspace.thread.status}
              onChange={(event) =>
                void updateStatus(event.target.value as typeof workspace.thread.status)
              }
              className="h-7 border border-border bg-background px-2 text-xs"
            >
              <option value="open">Open</option>
              <option value="wip">In progress</option>
              <option value="waiting">Waiting</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
            </select>
            <div className="flex min-w-[260px] flex-1 gap-2">
              <Input
                value={objectiveTitle}
                onChange={(event) => setObjectiveTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleAddObjective();
                }}
                placeholder="Add an objective"
                inputSize="sm"
              />
              <Button
                size="sm"
                onClick={() => void handleAddObjective()}
                disabled={!objectiveTitle.trim()}
              >
                Add
              </Button>
            </div>
          </div>
          {workspace.objectives.length > 0 && (
            <div className="mt-2 grid gap-1">
              {workspace.objectives.map((objective) => (
                <div key={objective.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={objective.status === "done"}
                    disabled={objective.status === "dropped"}
                    aria-label={`Complete ${objective.title}`}
                    onChange={(event) =>
                      void updateObjective({
                        objectiveId: objective.id,
                        status: event.target.checked ? "done" : "open",
                      })
                    }
                  />
                  <span
                    className={cn(
                      "flex-1",
                      objective.status !== "open" && "line-through opacity-60",
                    )}
                  >
                    {objective.title}
                    {objective.dropReason ? ` — ${objective.dropReason}` : ""}
                  </span>
                  {objective.status !== "dropped" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 border-0 px-2 text-[10px] text-muted-foreground"
                      onClick={() => {
                        const reason = window
                          .prompt("Why is this objective being dropped?")
                          ?.trim();
                        if (reason) {
                          void updateObjective({
                            objectiveId: objective.id,
                            status: "dropped",
                            dropReason: reason,
                          });
                        }
                      }}
                    >
                      Drop
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Tasks and PRs</span>
            {availableTasks.length > 0 && (
              <>
                <select
                  aria-label="Task to link"
                  value={taskToLink}
                  onChange={(event) => setTaskToLink(event.target.value)}
                  className="h-7 min-w-[180px] border border-border bg-background px-2 text-xs"
                >
                  <option value="">Select a task</option>
                  {availableTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Objective for task"
                  value={taskObjectiveId}
                  onChange={(event) => setTaskObjectiveId(event.target.value)}
                  className="h-7 border border-border bg-background px-2 text-xs"
                >
                  <option value="">No objective</option>
                  {workspace.objectives.map((objective) => (
                    <option key={objective.id} value={objective.id}>
                      {objective.title}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={() => void handleLinkTask()} disabled={!taskToLink}>
                  Link
                </Button>
              </>
            )}
          </div>
          {workspace.tasks.length > 0 && (
            <div className="mt-2 grid gap-1">
              {workspace.tasks.map((task) => (
                <div key={task.taskId} className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() => onOpenTask?.(task.taskId)}
                  >
                    {task.title}
                  </button>
                  <Badge variant="outline" size="sm">
                    {task.status}
                  </Badge>
                  {task.prUrl && (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      PR #{task.prNumber}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 border-0 text-muted-foreground"
                    aria-label={`Unlink ${task.title}`}
                    onClick={() => void unlinkTask(task.taskId)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {workspaceError && (
        <p className="border-b border-border px-4 py-2 text-xs text-destructive">
          {workspaceError}
        </p>
      )}

      {/* Content area: sessions sidebar + messages */}
      <div className="flex flex-1 overflow-hidden">
        {/* Session sidebar */}
        {showSessions && (
          <div className="w-[220px] shrink-0 border-r border-border overflow-hidden">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              projectName={projectName}
              onSelect={handleSessionSelect}
              onCreate={handleNewChat}
              onDelete={handleDeleteSession}
              onRename={handleRenameSession}
            />
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto overscroll-contain py-2">
          {chatErrorCode === "aborted" && (
            <div className="px-3 pb-2">
              <div className="rounded border border-muted-foreground/30 bg-muted/40 p-2">
                <Badge variant="outline" className="border-muted-foreground/50">
                  Stopped
                </Badge>
                <p className="mt-1 text-xs text-muted-foreground">
                  Chat run was stopped. Any partial reply above has been saved.
                </p>
              </div>
            </div>
          )}
          {usageLimitsEnabled &&
            chatErrorCode === "CHAT_USAGE_LIMIT" &&
            !chatRuntimeLimitDisplay && (
              <div className="px-3 pb-2">
                <div className="rounded border border-amber-500/50 bg-amber-500/15 p-2">
                  <Badge
                    variant="outline"
                    className="border-amber-600/60 text-amber-700 dark:border-amber-400/50 dark:text-amber-300"
                  >
                    Usage Limit Reached
                  </Badge>
                  <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-200/90">
                    Runtime usage limit is currently exhausted. Wait for reset time and send again.
                  </p>
                </div>
              </div>
            )}
          {(isLoadingMessages || isLoadingSessions) && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Spinner size="lg" />
              <p className="text-xs">Loading messages...</p>
            </div>
          )}
          {!isLoadingMessages && !isLoadingSessions && messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Bot className="h-8 w-8 opacity-30" />
              <p className="text-xs">
                Ask anything about {projectName ? `"${projectName}"` : "this project"}
              </p>
            </div>
          )}
          {!isLoadingMessages &&
            !isLoadingSessions &&
            messages.map((msg, i) => (
              <MessageBubble
                key={i}
                message={msg}
                projectId={projectId ?? ""}
                sessionId={activeSessionId}
                onTaskCreated={handleTaskCreated}
                onOpenTask={onOpenTask}
              />
            ))}
          {isStreaming && (
            <TypingIndicator
              hasAssistantMessage={messages[messages.length - 1]?.role === "assistant"}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div
        className={cn(
          "border-t p-3 transition-colors",
          composerDragOver ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        <label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <Checkbox
            checked={explore}
            onChange={(e) => setExplore(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span title="Brainstorm, research or explore a topic">Explore</span>
        </label>
        {pendingFiles.length > 0 && (
          <>
            <div className="mb-1.5 flex flex-wrap gap-1">
              {pendingFiles.map((f, i) => (
                <AttachmentChip
                  key={i}
                  name={f.name}
                  onRemove={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
            <p className="mb-1 text-2xs text-muted-foreground">
              {summarizeAttachments(pendingFiles)}
              {pendingFiles.length >= CHAT_ATTACHMENT_WARN_AT &&
                pendingFiles.length < MAX_CHAT_ATTACHMENTS && (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">
                    · large batch may slow the agent
                  </span>
                )}
              {pendingFiles.length >= MAX_CHAT_ATTACHMENTS && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  · cap reached ({MAX_CHAT_ATTACHMENTS})
                </span>
              )}
            </p>
          </>
        )}
        {composerDragOver && (
          <p className="mb-1 text-2xs text-primary">Drop files or folders to attach (recursive).</p>
        )}
        {oversizeNotice.length > 0 && (
          <p className="mb-1 text-2xs text-amber-600 dark:text-amber-400">
            Skipped {oversizeNotice.length} file{oversizeNotice.length === 1 ? "" : "s"} over{" "}
            {ATTACHMENT_SIZE_HARD_LIMIT / 1_000_000}MB: {oversizeNotice.slice(0, 3).join(", ")}
            {oversizeNotice.length > 3 ? `, …` : ""}
          </p>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                void handleFilesSelected(e.target.files);
                e.target.value = "";
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={kerryPilotMode || isStreaming || pendingFiles.length >= MAX_CHAT_ATTACHMENTS}
            className="h-9 w-9 shrink-0 border-0 text-muted-foreground"
            aria-label="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              kerryPilotMode ? "Execution is disabled in pilot mode" : "Ask a question..."
            }
            disabled={kerryPilotMode}
            rows={1}
            containerClassName="flex-1"
            className="max-h-32 min-h-[2.25rem] resize-none bg-secondary/50"
          />
          {isStreaming ? (
            <Button
              onClick={() => void abortStream()}
              aria-label="Stop generation"
              variant="destructive"
              className="h-auto self-stretch w-9 shrink-0 rounded px-0"
            >
              <Square className="h-4 w-4 shrink-0" />
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={kerryPilotMode || !input.trim()}
              aria-label="Send message"
              className="h-auto self-stretch w-9 shrink-0 rounded px-0"
            >
              <Send className="h-4 w-4 shrink-0" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return embedded ? content : createPortal(content, document.body);
}
