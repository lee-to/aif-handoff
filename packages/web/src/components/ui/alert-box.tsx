import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertBoxVariants = cva("border px-3 py-2 text-sm rounded-none", {
  variants: {
    variant: {
      success: "border-success/30 bg-success/10 text-success",
      error: "border-destructive/30 bg-destructive/10 text-destructive",
      warning: "border-warning/30 bg-warning/10 text-warning",
      info: "border-info/30 bg-info/10 text-info",
    },
  },
  defaultVariants: {
    variant: "info",
  },
});

export interface AlertBoxProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertBoxVariants> {
  icon?: React.ReactNode;
}

function AlertBox({ variant, icon, className, children, ...props }: AlertBoxProps) {
  return (
    <div className={cn(alertBoxVariants({ variant }), className)} {...props}>
      {icon && <span className="mr-2 inline-flex shrink-0 items-center">{icon}</span>}
      {children}
    </div>
  );
}

export { AlertBox, alertBoxVariants };
