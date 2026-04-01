import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  createOverlayLayerId,
  isTopOverlayLayer,
  pushOverlayLayer,
} from "@/components/ui/overlayStack";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Sheet({ open, onOpenChange, children }: SheetProps) {
  const overlayLayerId = React.useRef(createOverlayLayerId("sheet"));

  React.useEffect(() => {
    if (!open) return;
    return pushOverlayLayer(overlayLayerId.current);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopOverlayLayer(overlayLayerId.current)) return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" style={{ top: "4rem" }}>
      <div
        className="fixed inset-0 bg-black/85 backdrop-blur-[1px]"
        style={{ top: "4rem" }}
        onClick={() => onOpenChange(false)}
      />
      {children}
    </div>
  );
}

function SheetContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fixed right-0 bottom-0 z-50 w-full max-w-lg border-l border-border bg-card p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.03)] transition-transform duration-200",
        className,
      )}
      style={{ top: "4rem", ...props.style }}
      {...props}
    >
      {children}
    </div>
  );
}

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-2 mb-6", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold", className)} {...props} />;
}

function SheetClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100"
      onClick={onClose}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose };
