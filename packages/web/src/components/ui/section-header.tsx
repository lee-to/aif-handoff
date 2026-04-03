import { cn } from "@/lib/utils";

const headingStyles = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

interface SectionHeaderProps {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ children, action, className }: SectionHeaderProps) {
  if (action) {
    return (
      <div className={cn("flex items-center justify-between gap-2", className)}>
        <h3 className={headingStyles}>{children}</h3>
        {action}
      </div>
    );
  }

  return <h3 className={cn(headingStyles, className)}>{children}</h3>;
}
