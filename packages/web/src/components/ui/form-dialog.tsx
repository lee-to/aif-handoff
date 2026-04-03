import * as React from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  error?: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  className?: string;
}

function FormDialog({
  open,
  onOpenChange,
  title,
  error,
  children,
  actions,
  className,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">{actions}</div>
      </DialogContent>
    </Dialog>
  );
}

export { FormDialog };
