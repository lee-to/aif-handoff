import { cn } from "@/lib/utils";

interface TableHeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  isCompact?: boolean;
  children: React.ReactNode;
  className?: string;
}

function TableHeaderCell({ isCompact, children, className, ...props }: TableHeaderCellProps) {
  return (
    <th
      className={cn(
        "px-3 uppercase tracking-[0.16em] text-muted-foreground",
        isCompact ? "py-1.5 text-[10px]" : "py-2 text-[11px]",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export { TableHeaderCell };
export type { TableHeaderCellProps };
