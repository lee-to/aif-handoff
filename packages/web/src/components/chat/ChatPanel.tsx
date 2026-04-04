import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { AttachmentChip } from "@/components/ui/attachment-chip";
import { useChat } from "@/hooks/useChat";
import { useChatSessions } from "@/hooks/useChatSessions";
import { useTask } from "@/hooks/useTasks";
import { useEffectiveChatRuntime } from "@/hooks/useRuntimeProfiles";
import { toAttachmentPayload } from "@/components/task/useTaskDetailActions";
import { SessionList } from "./SessionList";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import type { ChatAttachment } from "@aif/shared/browser";

interface ChatPanelProps {
  isOpen: boolean;
  projectId: string | null;
  taskId: string | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}

export function ChatPanel({ isOpen, projectId, taskId, onClose, onOpenTask }: ChatPanelProps) {
  const [showSessions, setShowSessions] = useState(false);

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    pinActiveSession,
    clearActiveSession,
    deleteSession,
    renameSession,
  } = useChatSessions(projectId);

  const {
    messages,
    isStreaming,
    chatErrorCode,
    explore,
    setExplore,
    sendMessage,
    clearMessages,
    newSession,
  } = useChat(projectId, activeSessionId, taskId);

  const { data: currentTask } = useTask(taskId);
  const { data: effectiveChatRuntime } = useEffectiveChatRuntime(projectId);
  const [input, setInput] = useState("");
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
  useOutsideClick(panelRef, onClose, isOpen);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    pinActiveSession();
    const files = pendingFiles.length > 0 ? pendingFiles : undefined;
    void sendMessage(input, files);
    setInput("");
    setPendingFiles([]);
  };

  const handleFilesSelected = async (fileList: FileList) => {
    const newFiles: ChatAttachment[] = [];
    for (const file of Array.from(fileList).slice(0, 5 - pendingFiles.length)) {
      const payload = await toAttachmentPayload(file);
      newFiles.push({
        name: payload.name,
        mimeType: payload.mimeType,
        size: payload.size,
        content: payload.content,
      });
    }
    setPendingFiles((prev) => [...prev, ...newFiles].slice(0, 5));
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

  // Find active session title
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeRuntimeProfileName =
    effectiveChatRuntime?.profile?.name ??
    (effectiveChatRuntime?.source === "none" ? "Default runtime" : "Unnamed profile");
  const activeRuntimeEngine = effectiveChatRuntime?.resolved
    ? `${effectiveChatRuntime.resolved.runtimeId}/${effectiveChatRuntime.resolved.providerId}`
    : effectiveChatRuntime?.profile
      ? `${effectiveChatRuntime.profile.runtimeId}/${effectiveChatRuntime.profile.providerId}`
      : "n/a";
  const activeRuntimeModel =
    effectiveChatRuntime?.resolved?.model ?? effectiveChatRuntime?.profile?.defaultModel ?? "auto";

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed bottom-0 left-0 z-chat flex w-[800px] flex-col",
        "border-r border-border bg-background",
        "transition-transform duration-300 ease-in-out",
        isOpen ? "translate-x-0" : "-translate-x-full",
      )}
      style={{ top: "var(--header-height, 65px)" }}
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
              {activeSession?.title ?? "AI Chat"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleNewChat}
              className="h-7 w-7 border-0 text-muted-foreground"
              aria-label="New chat"
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
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-7 w-7 border-0 text-muted-foreground"
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </Button>
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
      </div>

      {/* Content area: sessions sidebar + messages */}
      <div className="flex flex-1 overflow-hidden">
        {/* Session sidebar */}
        {showSessions && (
          <div className="w-[220px] shrink-0 border-r border-border overflow-hidden">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={handleSessionSelect}
              onCreate={handleNewChat}
              onDelete={handleDeleteSession}
              onRename={handleRenameSession}
            />
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto overscroll-contain py-2">
          {chatErrorCode === "CHAT_USAGE_LIMIT" && (
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
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Bot className="h-8 w-8 opacity-30" />
              <p className="text-xs">Ask anything about this project</p>
            </div>
          )}
          {messages.map((msg, i) => (
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
      <div className="border-t border-border p-3">
        <label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <Checkbox
            checked={explore}
            onChange={(e) => setExplore(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span title="Brainstorm, research or explore a topic">Explore</span>
        </label>
        {pendingFiles.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {pendingFiles.map((f, i) => (
              <AttachmentChip
                key={i}
                name={f.name}
                onRemove={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
          </div>
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
            disabled={isStreaming || pendingFiles.length >= 5}
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
            placeholder="Ask a question..."
            rows={1}
            className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-secondary/50"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            aria-label="Send message"
            className="w-9 self-stretch rounded"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
