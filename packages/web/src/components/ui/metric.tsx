import { cn } from "@/lib/utils";

interface MetricProps {
  label: string;
  value: React.ReactNode;
  description?: string;
  className?: string;
}

export function Metric({ label, value, description, className }: MetricProps) {
  return (
    <div className={cn("border border-border bg-card/50 px-3 py-2 rounded-none", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
