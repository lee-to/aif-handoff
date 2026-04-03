import { cn } from "@/lib/utils";

const gapMap = {
  sm: "gap-1",
  default: "gap-1.5",
} as const;

export function IconLabel({
  icon,
  children,
  className,
  gap = "default",
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  gap?: "sm" | "default";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center text-sm text-muted-foreground",
        gapMap[gap],
        className,
      )}
    >
      <span className="shrink-0 h-3.5 w-3.5">{icon}</span>
      {children}
    </span>
  );
}
