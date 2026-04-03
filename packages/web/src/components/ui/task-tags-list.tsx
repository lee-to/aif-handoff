import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TaskTagsListProps {
  tags?: string[];
  roadmapAlias?: string;
  isCompact?: boolean;
  className?: string;
}

function TaskTagsList({ tags, roadmapAlias, isCompact, className }: TaskTagsListProps) {
  const filteredTags = tags?.filter((t) => !t.startsWith("rm:") && t !== "roadmap") ?? [];

  if (!roadmapAlias && filteredTags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {roadmapAlias && (
        <Badge
          className={cn(
            "border-violet-500/35 bg-violet-500/15 text-violet-600 dark:text-violet-300",
            isCompact ? "px-1 py-0 text-[9px]" : "px-1.5 py-0 text-[10px]",
          )}
        >
          {roadmapAlias}
        </Badge>
      )}
      {filteredTags.map((tag) => (
        <Badge
          key={tag}
          className={cn(
            "border-slate-500/35 bg-slate-500/15 text-slate-600 dark:text-slate-300",
            isCompact ? "px-1 py-0 text-[9px]" : "px-1.5 py-0 text-[10px]",
          )}
        >
          {tag}
        </Badge>
      ))}
    </div>
  );
}

export { TaskTagsList };
export type { TaskTagsListProps };
