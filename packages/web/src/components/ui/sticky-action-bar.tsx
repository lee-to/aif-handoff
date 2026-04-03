import { cn } from "@/lib/utils";

interface StickyActionBarProps {
  children: React.ReactNode;
  visible?: boolean;
  className?: string;
}

export function StickyActionBar({ children, visible = true, className }: StickyActionBarProps) {
  if (!visible) return null;

  return (
    <div
      className={cn(
        "sticky bottom-0 flex items-center gap-2 border-t border-border bg-card/95 px-4 py-3 backdrop-blur-sm rounded-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
