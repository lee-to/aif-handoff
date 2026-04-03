import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

export function AuthorBadge({
  author,
  label,
  className,
}: {
  author: "human" | "agent";
  label?: string;
  className?: string;
}) {
  const isHuman = author === "human";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        isHuman ? "text-blue-400 dark:text-blue-400" : "text-agent",
        className,
      )}
    >
      {isHuman ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      {label ?? (isHuman ? "User" : "Agent")}
    </span>
  );
}
