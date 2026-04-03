import { cn } from "@/lib/utils";

interface ActionButtonGroupProps {
  children: React.ReactNode;
  className?: string;
}

export function ActionButtonGroup({ children, className }: ActionButtonGroupProps) {
  return <div className={cn("inline-flex items-center gap-1", className)}>{children}</div>;
}
