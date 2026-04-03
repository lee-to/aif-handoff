import { Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { InlineEditor } from "@/components/ui/inline-editor";

interface TaskDescriptionProps {
  description: string;
  onSave: (description: string) => void;
}

export function TaskDescription({ description, onSave }: TaskDescriptionProps) {
  const markdownClassName = "text-sm text-foreground/85";

  return (
    <InlineEditor
      value={description}
      onSave={onSave}
      renderView={({ value, onEdit }) => (
        <div className="group relative">
          {value ? (
            <Markdown content={value} className={markdownClassName} />
          ) : (
            <div className={markdownClassName}>
              <span className="text-muted-foreground italic">No description</span>
            </div>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="absolute right-0 top-0 h-6 w-6 border border-border bg-background opacity-0 transition-opacity group-hover:opacity-100"
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        </div>
      )}
      renderEdit={({ draft, onChange, onSave: doSave, onCancel }) => (
        <div className="space-y-2">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Editor</p>
              <Textarea
                value={draft}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    doSave();
                  }
                }}
                rows={10}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Preview</p>
              <div className="min-h-[13rem] border border-border bg-secondary/25 p-2">
                {draft.trim().length > 0 ? (
                  <Markdown content={draft} className={markdownClassName} />
                ) : (
                  <span className="text-xs italic text-muted-foreground">
                    Preview will appear here
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={doSave}>
              <Check className="h-3 w-3 mr-1" /> Save
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
          </div>
        </div>
      )}
    />
  );
}
