import { Bot, Circle, MessageSquare, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

const iconMap: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  cli: Terminal,
  agent: Bot,
  web: MessageSquare,
};

export function SourceIcon({
  source,
  className,
}: {
  source: "cli" | "agent" | "web" | string;
  className?: string;
}) {
  const Icon = iconMap[source] ?? Circle;
  return <Icon className={cn("h-3.5 w-3.5", className)} />;
}
