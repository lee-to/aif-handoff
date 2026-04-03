import * as React from "react";
import { cn } from "@/lib/utils";

export interface ListButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

const ListButton = React.forwardRef<HTMLButtonElement, ListButtonProps>(
  ({ className, active, ...props }, ref) => {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent/50 rounded-none text-left",
          active && "bg-accent/60 text-foreground",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
ListButton.displayName = "ListButton";

export { ListButton };
