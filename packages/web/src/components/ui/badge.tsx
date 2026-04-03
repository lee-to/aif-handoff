import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-none border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-primary/30 bg-primary/15 text-primary",
        secondary: "border-border bg-secondary text-secondary-foreground",
        destructive: "border-destructive/30 bg-destructive/15 text-destructive",
        outline: "border-border text-foreground",
        "priority-low": "border-priority-low/30 bg-priority-low/15 text-priority-low",
        "priority-medium": "border-priority-medium/30 bg-priority-medium/15 text-priority-medium",
        "priority-high": "border-priority-high/30 bg-priority-high/15 text-priority-high",
        "priority-urgent": "border-priority-urgent/30 bg-priority-urgent/15 text-priority-urgent",
        tool: "border-cyan-500/30 bg-cyan-500/10 text-cyan-400 dark:text-cyan-300",
        agent: "border-violet-500/30 bg-violet-500/10 text-violet-400 dark:text-violet-300",
        error: "border-destructive/30 bg-destructive/15 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
