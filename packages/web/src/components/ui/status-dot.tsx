import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusDotVariants = cva("rounded-full shrink-0", {
  variants: {
    size: {
      sm: "h-1.5 w-1.5",
      default: "h-2 w-2",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusDotVariants> {
  status: string;
}

function StatusDot({ status, size, className, style, ...props }: StatusDotProps) {
  return (
    <span
      className={cn(statusDotVariants({ size }), className)}
      style={{
        backgroundColor: `var(--color-status-${status}, var(--color-muted-foreground))`,
        ...style,
      }}
      {...props}
    />
  );
}

export { StatusDot, statusDotVariants };
