import {
  useRef,
  useEffect,
  useState,
  useCallback,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Send,
  Trash2,
  Bot,
  User,
  Loader2,
  X,
  Plus,
  CheckCircle2,
  ClipboardList,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import { Badge } from "@/components/ui/badge";
import { useChat } from "@/hooks/useChat";
import { useChatSessions } from "@/hooks/useChatSessions";
import { useTask, useCreateTask } from "@/hooks/useTasks";
import { parseChatActions } from "@/lib/chatActions";
import { SessionList } from "./SessionList";
import type { ChatMessage, ChatActionCreateTask } from "@aif/shared/browser";

interface ChatPanelProps {
  isOpen: boolean;
  projectId: string | null;
  taskId: string | null;
  onClose: () => void;
}

function CreateTaskCard({
  action,
  projectId,
  onCreated,
}: {
  action: ChatActionCreateTask;
  projectId: string;
  onCreated: () => void;
}) {
  const createTask = useCreateTask();
  const [created, setCreated] = useState(false);

  const handleCreate = () => {
    createTask.mutate(
      { projectId, title: action.title, description: action.description },
      {
        onSuccess: () => {
          setCreated(true);
          onCreated();
        },
      },
    );
  };

  return (
    <div className="mx-3 my-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 mb-2">
        <ClipboardList className="h-3.5 w-3.5" />
        New Task
      </div>
      <p className="text-sm font-medium text-foreground">{action.title}</p>
      {action.description && (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{action.description}</p>
      )}
      <div className="mt-2">
        {created ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Task created
          </span>
        ) : (
          <button
            onClick={handleCreate}
            disabled={createTask.isPending}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium",
              "bg-emerald-600 text-white hover:bg-emerald-700 transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            <Plus className="h-3 w-3" />
            {createTask.isPending ? "Creating..." : "Create Task"}
          </button>
        )}
      </div>
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  projectId,
  onTaskCreated,
}: {
  message: ChatMessage;
  projectId: string;
  onTaskCreated: () => void;
}) {
  const isUser = message.role === "user";
  const parsed = !isUser ? parseChatActions(message.content) : null;
  const displayContent = parsed?.text ?? message.content;
  const actions = parsed?.actions ?? [];

  return (
    <>
      <div className={cn("flex gap-2.5 px-3 py-2", isUser ? "flex-row-reverse" : "flex-row")}>
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs",
            isUser ? "bg-blue-600 text-white" : "bg-violet-600 text-white",
          )}
        >
          {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        </div>
        <div
          className={cn(
            "max-w-[85%] rounded-lg px-3 py-2 text-sm",
            isUser ? "bg-blue-600/15 text-foreground" : "bg-violet-600/15 text-foreground",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{displayContent}</p>
          ) : (
            <Markdown content={displayContent} className="text-sm" />
          )}
        </div>
      </div>
      {actions.map((action, i) =>
        action.type === "create_task" ? (
          <CreateTaskCard key={i} action={action} projectId={projectId} onCreated={onTaskCreated} />
        ) : null,
      )}
    </>
  );
});

function TypingIndicator({ hasAssistantMessage }: { hasAssistantMessage: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-3 py-1.5", hasAssistantMessage && "pl-12")}>
      <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
      <span className="text-xs text-muted-foreground">Working...</span>
    </div>
  );
}

export function ChatPanel({ isOpen, projectId, taskId, onClose }: ChatPanelProps) {
  const [showSessions, setShowSessions] = useState(false);

  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
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
  const [input, setInput] = useState("");
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
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!panelRef.current?.contains(target)) onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen, onClose]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    void sendMessage(input);
    setInput("");
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

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed bottom-0 left-0 z-[55] flex w-[800px] flex-col",
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
            <button
              onClick={() => setShowSessions((v) => !v)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={showSessions ? "Hide sessions" : "Show sessions"}
            >
              {showSessions ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
            <Bot className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold truncate max-w-[300px]">
              {activeSession?.title ?? "AI Chat"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleNewChat}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="New chat"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={clearMessages}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Clear messages"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Close chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {currentTask && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClipboardList className="h-3 w-3" />
            <span className="truncate max-w-[90%]">
              Task: <span className="text-foreground font-medium">{currentTask.title}</span>
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
                {currentTask.status}
              </Badge>
            </span>
          </div>
        )}
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
                  Claude usage limit is currently exhausted. Wait for reset time and send again.
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
              onTaskCreated={handleTaskCreated}
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
          <input
            type="checkbox"
            checked={explore}
            onChange={(e) => setExplore(e.target.checked)}
            className="accent-primary h-3.5 w-3.5"
          />
          <span title="Brainstorm, research or explore a topic">Explore</span>
        </label>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            rows={1}
            className={cn(
              "flex-1 resize-none rounded border border-border bg-secondary/50 px-3 py-2",
              "text-sm text-foreground placeholder:text-muted-foreground",
              "focus:border-primary/50 focus:outline-none",
              "max-h-32 min-h-[2.25rem]",
            )}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className={cn(
              "flex w-9 items-center justify-center self-stretch rounded",
              "bg-primary text-primary-foreground",
              "transition-colors hover:bg-primary/90",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
