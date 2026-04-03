import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Collapsible({
  open,
  onOpenChange,
  trigger,
  children,
  className,
}: CollapsibleProps) {
  return (
    <div className={cn(className)}>
      <button
        type="button"
        className="inline-flex items-center gap-1 border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground rounded-none"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {trigger}
      </button>
      {open && children}
    </div>
  );
}
