import { useEffect, useRef } from "react";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterButton } from "@/components/ui/filter-button";
import { kindBadgeStyle } from "@/hooks/useStatusColor";
import { useActivityLogParsing } from "@/hooks/useActivityLogParsing";

interface AgentTimelineProps {
  activityLog: string | null;
}

export function AgentTimeline({ activityLog }: AgentTimelineProps) {
  const { visibleEntries, filter, setFilter } = useActivityLogParsing(activityLog);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activityLog, filter]);

  if (!activityLog) {
    return <EmptyState message="No agent activity yet" />;
  }

  return (
    <div className="border border-border bg-secondary/35 p-3">
      <div className="mb-2 flex items-center gap-2">
        <FilterButton size="sm" active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterButton>
        <FilterButton size="sm" active={filter === "agent"} onClick={() => setFilter("agent")}>
          Agents
        </FilterButton>
        <FilterButton size="sm" active={filter === "tool"} onClick={() => setFilter("tool")}>
          Tools
        </FilterButton>
        <FilterButton size="sm" active={filter === "error"} onClick={() => setFilter("error")}>
          Errors
        </FilterButton>
        <span className="ml-auto text-3xs text-muted-foreground">{visibleEntries.length}</span>
      </div>

      <div ref={scrollRef} className="max-h-64 space-y-2 overflow-y-auto">
        {visibleEntries.map((parsed, i) => {
          const badge = kindBadgeStyle(parsed.kind);

          return (
            <div
              key={i}
              className={`border p-2 text-xs ${
                parsed.kind === "agent"
                  ? "border-violet-500/30 bg-violet-500/5"
                  : "border-border bg-background/60"
              }`}
            >
              <div className="mb-1 flex items-center gap-2">
                <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className={`inline-flex border px-1.5 py-0.5 text-3xs ${badge.className}`}>
                  {badge.label}
                </span>
                {parsed.timestamp && (
                  <span className="ml-auto text-3xs text-muted-foreground font-mono">
                    {parsed.timestamp}
                  </span>
                )}
              </div>
              <div className="font-mono text-foreground/80">
                {parsed.toolName ? (
                  <>
                    <span className="text-muted-foreground">Tool:</span> {parsed.toolName}
                  </>
                ) : (
                  parsed.message
                )}
              </div>
              {parsed.runtimeMeta && (
                <div className="mt-1 flex gap-2 text-3xs text-muted-foreground font-mono">
                  {parsed.runtimeMeta.runtimeId && (
                    <span>runtime:{parsed.runtimeMeta.runtimeId}</span>
                  )}
                  {parsed.runtimeMeta.transport && (
                    <span>transport:{parsed.runtimeMeta.transport}</span>
                  )}
                  {parsed.runtimeMeta.model && <span>model:{parsed.runtimeMeta.model}</span>}
                  {parsed.runtimeMeta.profileId && (
                    <span>profile:{parsed.runtimeMeta.profileId}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
