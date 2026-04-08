import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  createOverlayLayerId,
  isTopOverlayLayer,
  pushOverlayLayer,
} from "@/components/ui/overlayStack";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const overlayLayerId = React.useRef(createOverlayLayerId("dialog"));

  React.useEffect(() => {
    if (!open) return;
    return pushOverlayLayer(overlayLayerId.current);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTopOverlayLayer(overlayLayerId.current)) return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: "var(--z-modal)" }}>
      <div className="fixed inset-0 bg-black/85 animate-in fade-in-0" />
      <div
        className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onOpenChange(false);
          }
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DialogContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative w-full max-w-lg rounded-none border border-border bg-card p-6 animate-in fade-in-0 zoom-in-95",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mb-6 flex flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
  );
}

function DialogClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100"
      onClick={onClose}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose };
