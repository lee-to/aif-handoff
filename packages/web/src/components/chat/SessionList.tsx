import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { SourceIcon } from "@/components/ui/source-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, timeAgo } from "@/lib/utils";
import type { ChatSession } from "@aif/shared/browser";

interface SessionListProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  projectName: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  projectName,
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
        <Button
          variant="ghost"
          size="sm"
          onClick={onCreate}
          className="w-full gap-1.5 bg-primary/10 text-primary hover:bg-primary/20"
        >
          <Plus className="h-3.5 w-3.5" />
          New Thread
        </Button>
        <p className="mt-2 text-3xs uppercase tracking-[0.12em] text-muted-foreground">
          {projectName ? `Current Project: ${projectName}` : "Current Project"}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No threads yet</p>
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
            <SourceIcon
              source={session.source}
              className={cn(
                "shrink-0",
                session.source === "cli"
                  ? "text-amber-500"
                  : session.source === "agent"
                    ? "text-violet-500"
                    : "text-muted-foreground",
              )}
            />
            <div className="flex-1 min-w-0">
              {editingId === session.id ? (
                <div className="flex items-center gap-1">
                  <Input
                    ref={inputRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    inputSize="sm"
                    className="w-full bg-transparent border-0 border-b border-primary/50 rounded-none px-0 text-xs"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 border-0 text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      commitRename();
                    }}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 border-0 text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelRename();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-xs font-medium text-foreground truncate">{session.title}</p>
                  <p className="text-3xs text-muted-foreground">
                    <span className="mr-1 uppercase font-semibold">{session.status}</span>
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
                    {timeAgo(session.updatedAt)}
                  </p>
                </>
              )}
            </div>
            {editingId !== session.id && session.source === "web" && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 border-0 text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(session);
                  }}
                  title="Rename"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 border-0 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
