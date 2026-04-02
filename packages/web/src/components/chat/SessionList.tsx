import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MessageSquare, Plus, Trash2, Pencil, Check, X, Terminal, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatSession } from "@aif/shared/browser";

interface SessionListProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const startRename = (session: ChatSession) => {
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const commitRename = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  const handleRenameKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") cancelRename();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={onCreate}
          className={cn(
            "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium",
            "bg-primary/10 text-primary hover:bg-primary/20 transition-colors",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            No conversations yet
          </p>
        )}
        {sessions.map((session) => (
          <div
            key={session.id}
            className={cn(
              "group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors",
              "hover:bg-secondary/60",
              session.id === activeSessionId && "bg-primary/10 border-r-2 border-primary",
            )}
            onClick={() => {
              if (editingId !== session.id) onSelect(session.id);
            }}
          >
            {session.source === "cli" ? (
              <Terminal className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            ) : session.source === "agent" ? (
              <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="flex-1 min-w-0">
              {editingId === session.id ? (
                <div className="flex items-center gap-1">
                  <input
                    ref={inputRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    className="w-full bg-transparent text-xs border-b border-primary/50 outline-none text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      commitRename();
                    }}
                    className="text-primary"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelRename();
                    }}
                    className="text-muted-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-xs font-medium text-foreground truncate">{session.title}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {session.source !== "web" && (
                      <span
                        className={cn(
                          "mr-1 uppercase font-semibold",
                          session.source === "cli" ? "text-amber-500/80" : "text-violet-500/80",
                        )}
                      >
                        {session.source}
                      </span>
                    )}
                    {formatRelativeTime(session.updatedAt)}
                  </p>
                </>
              )}
            </div>
            {editingId !== session.id && session.source === "web" && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(session);
                  }}
                  className="p-0.5 text-muted-foreground hover:text-foreground"
                  title="Rename"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  className="p-0.5 text-muted-foreground hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
