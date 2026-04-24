import { useMemo } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRuntimeProfiles } from "@/hooks/useRuntimeProfiles";
import { RuntimeUsageEntryCard } from "./RuntimeUsageEntryCard";
import { buildRuntimeUsageEntries } from "./runtimeUsageDialogModel";

interface RuntimeUsageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}

export function RuntimeUsageDialog({ open, onOpenChange, projectId }: RuntimeUsageDialogProps) {
  const { data: profiles = [], isLoading } = useRuntimeProfiles(projectId, true);
  const entries = useMemo(() => buildRuntimeUsageEntries(profiles), [profiles]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle>Runtime Usage</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Last known quota windows and recorded usage across configured runtimes. Some transports
            expose live quota state, while others only report per-run token usage.
          </p>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading runtime usage…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No enabled runtime profiles configured.</p>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <RuntimeUsageEntryCard key={entry.key} entry={entry} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
