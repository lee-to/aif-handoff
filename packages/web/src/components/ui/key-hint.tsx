import { cn } from "@/lib/utils";

interface KeyHintProps {
  keys: string[];
  className?: string;
}

export function KeyHint({ keys, className }: KeyHintProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
          <kbd className="border border-border bg-card/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground rounded-none">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}
