import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const cardVariants = cva("border rounded-none p-3", {
  variants: {
    variant: {
      default: "border-border bg-card",
      muted: "border-border bg-card/65",
      ghost: "border-transparent bg-transparent",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => {
    return <div className={cn(cardVariants({ variant, className }))} ref={ref} {...props} />;
  },
);
Card.displayName = "Card";

export { Card, cardVariants };
