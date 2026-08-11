import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  createOverlayLayerId,
  isTopOverlayLayer,
  pushOverlayLayer,
} from "@/components/ui/overlayStack";

interface DropdownMenuContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenu() {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) throw new Error("DropdownMenu compound components must be used within <DropdownMenu>");
  return ctx;
}

interface DropdownMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function DropdownMenu({ open, onOpenChange, children }: DropdownMenuProps) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const overlayLayerId = React.useRef(createOverlayLayerId("dropdown-menu"));

  React.useEffect(() => {
    if (!open) return;
    return pushOverlayLayer(overlayLayerId.current);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopOverlayLayer(overlayLayerId.current)) return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const value = React.useMemo(() => ({ open, onOpenChange, triggerRef }), [open, onOpenChange]);

  return <DropdownMenuContext.Provider value={value}>{children}</DropdownMenuContext.Provider>;
}

interface DropdownMenuTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

function DropdownMenuTrigger({ children, asChild }: DropdownMenuTriggerProps) {
  const { open, onOpenChange, triggerRef } = useDropdownMenu();

  if (asChild) {
    return (
      <span
        ref={triggerRef as React.RefObject<HTMLSpanElement>}
        onClick={() => onOpenChange(!open)}
        className="inline-flex"
      >
        {children}
      </span>
    );
  }

  return (
    <button ref={triggerRef} type="button" onClick={() => onOpenChange(!open)}>
      {children}
    </button>
  );
}

interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
}

function DropdownMenuContent({
  align = "start",
  className,
  children,
  ...props
}: DropdownMenuContentProps) {
  const { open, onOpenChange, triggerRef } = useDropdownMenu();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  React.useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = align === "end" ? rect.right : rect.left;
    setPosition({ top: rect.bottom, left });
  }, [open, align, triggerRef]);

  React.useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onOpenChange, triggerRef]);

  if (!open || typeof document === "undefined") return null;

  const style: React.CSSProperties = {
    position: "fixed",
    top: position.top,
    ...(align === "end" ? { right: window.innerWidth - position.left } : { left: position.left }),
  };

  return createPortal(
    <div
      ref={contentRef}
      role="menu"
      className={cn(
        "border border-border bg-popover p-1 shadow-lg rounded-none z-50 min-w-[160px]",
        className,
      )}
      style={style}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}

interface DropdownMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  destructive?: boolean;
}

function DropdownMenuItem({
  destructive,
  className,
  onClick,
  children,
  ...props
}: DropdownMenuItemProps) {
  const { onOpenChange } = useDropdownMenu();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    onOpenChange(false);
  };

  return (
    <button
      role="menuitem"
      type="button"
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent/50 rounded-none cursor-pointer",
        destructive && "text-destructive hover:bg-destructive/10",
        className,
      )}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
