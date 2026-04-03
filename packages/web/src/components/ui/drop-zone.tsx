import * as React from "react";
import { useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

interface DropZoneProps {
  onFiles: (files: FileList) => void;
  label?: string;
  className?: string;
  children?: React.ReactNode;
}

function DropZone({
  onFiles,
  label = "Drag files here to attach",
  className,
  children,
}: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      onFiles(e.dataTransfer.files);
    }
  };

  return (
    <div
      className={cn(
        "border border-dashed p-3 text-center text-xs transition-colors",
        dragOver
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border bg-secondary/20 text-muted-foreground",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="region"
      aria-label={label}
    >
      {children ?? (
        <span className="flex items-center justify-center gap-1.5">
          <Upload className="h-3.5 w-3.5" />
          {label}
        </span>
      )}
    </div>
  );
}

export { DropZone };
export type { DropZoneProps };
