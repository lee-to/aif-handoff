import { useMemo } from "react";
import { Download } from "lucide-react";
import { useTaskComments } from "@/hooks/useTasks";
import { Markdown } from "@/components/ui/markdown";
import { AuthorBadge } from "@/components/ui/author-badge";

interface TaskCommentsProps {
  taskId: string;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function TaskComments({ taskId }: TaskCommentsProps) {
  const { data: comments, isLoading } = useTaskComments(taskId);
  const reversedComments = useMemo(() => (comments ? [...comments].reverse() : []), [comments]);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground italic">Loading comments...</div>;
  }

  if (!comments || comments.length === 0) {
    return <div className="text-sm text-muted-foreground italic">No comments yet</div>;
  }

  return (
    <div className="space-y-3">
      {reversedComments.map((comment) => (
        <div
          key={comment.id}
          className={`border p-3 ${
            comment.author === "human"
              ? "border-blue-500/30 bg-blue-500/5"
              : "border-violet-500/30 bg-violet-500/5"
          }`}
        >
          <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <AuthorBadge author={comment.author} />
            <span>{formatWhen(comment.createdAt)}</span>
          </div>
          <Markdown content={comment.message} className="text-sm text-foreground/90" />
          {comment.attachments.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Attachments
              </p>
              <ul className="space-y-1 text-xs text-foreground/80">
                {comment.attachments.map((file, index) => (
                  <li
                    key={`${comment.id}-${file.name}-${index}`}
                    className="flex items-center gap-2"
                  >
                    <span className="truncate">
                      {file.name} ({file.mimeType || "unknown"}, {file.size} bytes)
                      {file.content == null && !file.path && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          (metadata only)
                        </span>
                      )}
                    </span>
                    {file.path && (
                      <a
                        href={`/tasks/${taskId}/comments/${comment.id}/attachments/${encodeURIComponent(file.name)}`}
                        download={file.name}
                        className="inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
                        title="Download"
                      >
                        <Download className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
