import { Download, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatFileSize } from "@/lib/formatFileSize";

interface FileListItemProps {
  name: string;
  mimeType?: string;
  size?: number;
  downloadUrl?: string;
  metadataOnly?: boolean;
  onRemove?: () => void;
  className?: string;
}

function FileListItem({
  name,
  mimeType,
  size,
  downloadUrl,
  metadataOnly,
  onRemove,
  className,
}: FileListItemProps) {
  return (
    <li
      className={cn(
        "flex items-center justify-between gap-3 border border-border bg-secondary/30 px-2 py-1.5 text-xs text-foreground/85",
        className,
      )}
    >
      <span className="truncate">
        {name}
        {" ("}
        {mimeType || "unknown"}
        {size != null && `, ${formatFileSize(size)}`}
        {")"}
        {metadataOnly && (
          <span className="ml-1 text-[10px] text-muted-foreground">(metadata only)</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {downloadUrl && (
          <a
            href={downloadUrl}
            download={name}
            className="inline-flex h-6 items-center gap-1 px-2 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            title="Download"
            aria-label={`Download ${name}`}
          >
            <Download className="h-3 w-3" />
          </a>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-6 items-center gap-1 px-2 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Remove ${name}`}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
    </li>
  );
}

export { FileListItem };
export type { FileListItemProps };
