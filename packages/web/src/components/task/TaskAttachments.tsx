import { useState } from "react";
import type { TaskCommentAttachment } from "@aif/shared/browser";
import { ToggleButton } from "@/components/ui/toggle-button";
import { FileInput } from "@/components/ui/file-input";
import { DropZone } from "@/components/ui/drop-zone";
import { FileListItem } from "@/components/ui/file-list-item";

interface TaskAttachmentsProps {
  taskId: string;
  attachments: TaskCommentAttachment[];
  onFilesSelected: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}

export function TaskAttachments({
  taskId,
  attachments,
  onFilesSelected,
  onRemove,
}: TaskAttachmentsProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-3">
      <ToggleButton expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? "Hide attachments" : `Show attachments (${attachments.length})`}
      </ToggleButton>

      {expanded && (
        <>
          <DropZone onFiles={(files) => onFilesSelected(files)} />
          <FileInput
            multiple
            label="Attach files"
            onChange={(e) => {
              onFilesSelected(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          {attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No files attached to this task.</p>
          ) : (
            <ul className="space-y-1">
              {attachments.map((file, index) => (
                <FileListItem
                  key={`${file.name}-${index}`}
                  name={file.name}
                  mimeType={file.mimeType}
                  size={file.size}
                  downloadUrl={
                    file.path
                      ? `/tasks/${taskId}/attachments/${encodeURIComponent(file.name)}`
                      : undefined
                  }
                  metadataOnly={file.content == null && !file.path}
                  onRemove={() => onRemove(index)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
