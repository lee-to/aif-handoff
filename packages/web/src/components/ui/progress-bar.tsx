import { cn } from "@/lib/utils";

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
}

function ProgressBar({ value, className, ...props }: ProgressBarProps) {
  return (
    <div
      className={cn(
        "h-1 w-full overflow-hidden rounded-none bg-secondary border border-border",
        className,
      )}
      {...props}
    >
      <div className="h-full bg-primary transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}

export { ProgressBar };
