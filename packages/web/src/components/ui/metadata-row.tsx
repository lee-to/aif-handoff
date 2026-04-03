import { cn } from "@/lib/utils";

interface MetadataRowProps {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  className?: string;
}

export function MetadataRow({ icon, label, value, className }: MetadataRowProps) {
  return (
    <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground", className)}>
      {icon && <span className="shrink-0 h-3.5 w-3.5">{icon}</span>}
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground ml-auto">{value}</span>
    </div>
  );
}
