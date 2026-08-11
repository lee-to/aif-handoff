import { Button } from "@/components/ui/button";
import { FilterButton } from "@/components/ui/filter-button";

type QuickFilter =
  | "mine"
  | "human_owned"
  | "ai_owned"
  | "unassigned"
  | "blocked"
  | "recent"
  | "no_plan"
  | "roadmap";

const FILTER_LABELS: Record<QuickFilter, string> = {
  mine: "mine",
  human_owned: "human-owned",
  ai_owned: "AI-owned",
  unassigned: "unassigned",
  blocked: "blocked",
  recent: "recent",
  no_plan: "no plan",
  roadmap: "roadmap",
};

interface FilterBarProps {
  activeFilters: QuickFilter[];
  onToggleFilter: (filter: QuickFilter) => void;
  onClearFilters: () => void;
  isCompact: boolean;
  roadmapAliases: string[];
  activeRoadmapAliases: string[];
  onToggleRoadmapAlias: (alias: string) => void;
  assignees: Array<{ participantId: string; displayName: string }>;
  activeAssigneeIds: string[];
  onToggleAssignee: (participantId: string) => void;
}

export type { QuickFilter };

export function FilterBar({
  activeFilters,
  onToggleFilter,
  onClearFilters,
  isCompact,
  roadmapAliases,
  activeRoadmapAliases,
  onToggleRoadmapAlias,
  assignees,
  activeAssigneeIds,
  onToggleAssignee,
}: FilterBarProps) {
  return (
    <>
      <div
        className={`mb-4 flex flex-wrap items-center gap-2 border border-border bg-card/45 ${isCompact ? "px-2 py-1.5" : "px-3 py-2"}`}
      >
        <span className="min-w-12 text-2xs uppercase tracking-label text-muted-foreground">
          Filters
        </span>
        {(Object.keys(FILTER_LABELS) as QuickFilter[]).map((key) => (
          <FilterButton
            key={key}
            active={activeFilters.includes(key)}
            onClick={() => onToggleFilter(key)}
            size={isCompact ? "sm" : "default"}
          >
            {FILTER_LABELS[key]}
          </FilterButton>
        ))}
        {activeFilters.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClearFilters}>
            clear filters
          </Button>
        )}
      </div>

      {activeFilters.includes("human_owned") && assignees.length > 0 && (
        <div
          data-testid="assignee-filters"
          className={`-mt-2 mb-4 flex flex-wrap items-center gap-2 border border-border bg-card/35 ${isCompact ? "px-2 py-1.5" : "px-3 py-2"}`}
        >
          <span className="min-w-12 text-2xs uppercase tracking-label text-muted-foreground">
            Assignee
          </span>
          {assignees.map((assignee) => (
            <FilterButton
              key={assignee.participantId}
              active={activeAssigneeIds.includes(assignee.participantId)}
              onClick={() => onToggleAssignee(assignee.participantId)}
              size={isCompact ? "sm" : "default"}
            >
              {assignee.displayName}
            </FilterButton>
          ))}
        </div>
      )}

      {activeFilters.includes("roadmap") && roadmapAliases.length > 0 && (
        <div
          data-testid="roadmap-alias-filters"
          className={`-mt-2 mb-4 flex flex-wrap items-center gap-2 border border-border bg-card/35 ${isCompact ? "px-2 py-1.5" : "px-3 py-2"}`}
        >
          <span className="min-w-12 text-2xs uppercase tracking-label text-muted-foreground">
            Roadmap
          </span>
          {roadmapAliases.map((alias) => (
            <FilterButton
              key={alias}
              active={activeRoadmapAliases.includes(alias)}
              onClick={() => onToggleRoadmapAlias(alias)}
              size={isCompact ? "sm" : "default"}
              activeClassName="border-violet-500/45 bg-violet-500/15 text-violet-400"
            >
              {alias}
            </FilterButton>
          ))}
        </div>
      )}
    </>
  );
}
