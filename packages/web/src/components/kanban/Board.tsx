import { useEffect, useMemo, useState } from "react";
import { ORDERED_STATUSES, STATUS_CONFIG, type Task, type TaskStatus } from "@aif/shared/browser";
import { useTasks } from "@/hooks/useTasks";
import { Column } from "./Column";
import { Button } from "@/components/ui/button";
import { AddTaskForm } from "./AddTaskForm";
import { Input } from "@/components/ui/input";
import { readStorage, writeStorage } from "@/lib/storage";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { TableHeaderCell } from "@/components/ui/table-header-cell";

type QuickFilter = "mine" | "blocked" | "recent" | "no_plan" | "roadmap";
type ViewMode = "kanban" | "list";
type ListSort = "updated_desc" | "updated_asc" | "priority_desc" | "priority_asc" | "status";

interface BoardProps {
  projectId: string;
  onTaskClick: (taskId: string) => void;
  density: "comfortable" | "compact";
  viewMode?: ViewMode;
}

const FILTER_LABELS: Record<QuickFilter, string> = {
  mine: "mine",
  blocked: "blocked",
  recent: "recent",
  no_plan: "no plan",
  roadmap: "roadmap",
};
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_CUTOFF_REFERENCE_TS = Date.now();

const STATUS_ORDER = Object.fromEntries(
  ORDERED_STATUSES.map((status, idx) => [status, idx]),
) as Record<TaskStatus, number>;

export function Board({ projectId, onTaskClick, density, viewMode = "kanban" }: BoardProps) {
  const { data: tasks, isLoading } = useTasks(projectId);
  const isCompact = density === "compact";
  const [activeFilters, setActiveFilters] = useState<QuickFilter[]>([]);
  const [activeRoadmapAliases, setActiveRoadmapAliases] = useState<string[]>([]);
  const [listQuery, setListQuery] = useState(() => {
    return readStorage(STORAGE_KEYS.LIST_QUERY) ?? "";
  });
  const [listSort, setListSort] = useState<ListSort>(() => {
    const saved = readStorage(STORAGE_KEYS.LIST_SORT);
    return saved === "updated_asc" ||
      saved === "priority_desc" ||
      saved === "priority_asc" ||
      saved === "status"
      ? saved
      : "updated_desc";
  });

  useEffect(() => {
    writeStorage(STORAGE_KEYS.LIST_QUERY, listQuery);
  }, [listQuery]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.LIST_SORT, listSort);
  }, [listSort]);

  const toggleFilter = (filter: QuickFilter) => {
    setActiveFilters((prev) => {
      const next = prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter];
      if (filter === "roadmap" && next.includes("roadmap") === false) {
        setActiveRoadmapAliases([]);
      }
      return next;
    });
  };

  const toggleRoadmapAlias = (alias: string) => {
    setActiveRoadmapAliases((prev) =>
      prev.includes(alias) ? prev.filter((a) => a !== alias) : [...prev, alias],
    );
  };

  const roadmapAliases = useMemo(() => {
    const all = tasks ?? [];
    const aliases = new Set<string>();
    for (const task of all) {
      if (task.tags?.includes("roadmap") && task.roadmapAlias) {
        aliases.add(task.roadmapAlias);
      }
    }
    return [...aliases].sort();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const all = tasks ?? [];

    return all.filter((task) => {
      if (activeFilters.includes("mine") && task.autoMode) return false;
      if (activeFilters.includes("blocked") && task.status !== "blocked_external") return false;
      if (activeFilters.includes("recent")) {
        const updatedTs = new Date(task.updatedAt).getTime();
        const oneDayAgo = RECENT_CUTOFF_REFERENCE_TS - ONE_DAY_MS;
        if (updatedTs < oneDayAgo) return false;
      }
      if (activeFilters.includes("no_plan") && (task.plan?.trim()?.length ?? 0) > 0) return false;
      if (activeFilters.includes("roadmap")) {
        if (!task.tags || !task.tags.includes("roadmap")) return false;
        if (
          activeRoadmapAliases.length > 0 &&
          !activeRoadmapAliases.includes(task.roadmapAlias ?? "")
        )
          return false;
      }
      return true;
    });
  }, [activeFilters, activeRoadmapAliases, tasks]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      backlog: [],
      planning: [],
      plan_ready: [],
      implementing: [],
      review: [],
      blocked_external: [],
      done: [],
      verified: [],
    };

    for (const task of filteredTasks) {
      grouped[task.status]?.push(task);
    }

    for (const status of ORDERED_STATUSES) {
      grouped[status].sort((a, b) => a.position - b.position);
    }

    return grouped;
  }, [filteredTasks]);

  const listTasks = useMemo(() => {
    const query = listQuery.trim().toLowerCase();
    const searched = query
      ? filteredTasks.filter((task) => {
          return (
            task.title.toLowerCase().includes(query) ||
            (task.description ?? "").toLowerCase().includes(query) ||
            task.id.toLowerCase().includes(query) ||
            STATUS_CONFIG[task.status].label.toLowerCase().includes(query)
          );
        })
      : filteredTasks;

    return [...searched].sort((a, b) => {
      if (listSort === "updated_desc") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (listSort === "updated_asc") {
        return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      if (listSort === "priority_desc") {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (listSort === "priority_asc") {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }

      const statusOrderDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (statusOrderDiff !== 0) return statusOrderDiff;
      return a.position - b.position;
    });
  }, [filteredTasks, listQuery, listSort]);

  if (isLoading && viewMode === "kanban") {
    return (
      <div className="flex gap-4 overflow-x-auto pb-6">
        {ORDERED_STATUSES.map((status) => (
          <div key={status} className="w-80 flex-shrink-0 border border-border bg-card/65 p-3">
            <div className="mb-3 h-10 border border-border bg-secondary/40" />
            <div className="space-y-2">
              <div className="h-20 border border-border bg-secondary/25" />
              <div className="h-20 border border-border bg-secondary/20" />
              <div className="h-20 border border-border bg-secondary/15" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isLoading && viewMode === "list") {
    return (
      <div className="border border-border bg-card/65 p-3">
        <div className="mb-2 h-9 border border-border bg-secondary/40" />
        <div className="space-y-2">
          <div className="h-12 border border-border bg-secondary/25" />
          <div className="h-12 border border-border bg-secondary/20" />
          <div className="h-12 border border-border bg-secondary/15" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`mb-4 flex flex-wrap items-center gap-2 border border-border bg-card/45 ${isCompact ? "px-2 py-1.5" : "px-3 py-2"}`}
      >
        <span className="min-w-12 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Filters
        </span>
        {(Object.keys(FILTER_LABELS) as QuickFilter[]).map((key) => {
          const active = activeFilters.includes(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleFilter(key)}
              className={`border font-mono transition-colors ${
                isCompact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"
              } ${
                active
                  ? "border-primary/45 bg-primary/15 text-primary"
                  : "border-border bg-background/45 text-muted-foreground hover:bg-background"
              }`}
            >
              {FILTER_LABELS[key]}
            </button>
          );
        })}
        {activeFilters.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setActiveFilters([]);
              setActiveRoadmapAliases([]);
            }}
          >
            clear filters
          </Button>
        )}
      </div>

      {activeFilters.includes("roadmap") && roadmapAliases.length > 0 && (
        <div
          data-testid="roadmap-alias-filters"
          className={`-mt-2 mb-4 flex flex-wrap items-center gap-2 border border-border bg-card/35 ${isCompact ? "px-2 py-1.5" : "px-3 py-2"}`}
        >
          <span className="min-w-12 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Roadmap
          </span>
          {roadmapAliases.map((alias) => {
            const active = activeRoadmapAliases.includes(alias);
            return (
              <button
                key={alias}
                type="button"
                onClick={() => toggleRoadmapAlias(alias)}
                className={`border font-mono transition-colors ${
                  isCompact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"
                } ${
                  active
                    ? "border-violet-500/45 bg-violet-500/15 text-violet-400"
                    : "border-border bg-background/45 text-muted-foreground hover:bg-background"
                }`}
              >
                {alias}
              </button>
            );
          })}
        </div>
      )}

      {filteredTasks.length === 0 && (
        <div className="mb-4 border border-dashed border-border bg-card/40 p-6 text-center">
          <p className="text-sm font-medium">No tasks for current view</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {activeFilters.length > 0
              ? "Adjust filters or clear them to see more tasks"
              : "Create a task in Backlog to kick off automation"}
          </p>
          {activeFilters.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setActiveFilters([])}
            >
              Show all tasks
            </Button>
          )}
        </div>
      )}

      {viewMode === "kanban" ? (
        <div className="flex gap-4 overflow-x-auto pb-6">
          {ORDERED_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              projectId={projectId}
              totalVisibleTasks={filteredTasks.length}
              density={density}
              hasActiveFilters={activeFilters.length > 0}
              onTaskClick={onTaskClick}
            />
          ))}
        </div>
      ) : (
        <div className={`${isCompact ? "space-y-2" : "space-y-3"} pb-6`}>
          <div>
            <AddTaskForm projectId={projectId} />
          </div>
          <div
            className={`flex flex-col gap-2 border border-border bg-card/45 ${isCompact ? "p-1.5" : "p-2"} md:flex-row md:items-center`}
          >
            <Input
              value={listQuery}
              onChange={(event) => setListQuery(event.target.value)}
              placeholder="Search by title, description, id, status"
              className={`${isCompact ? "h-7 text-xs" : "h-8"} md:max-w-lg`}
            />
            <select
              value={listSort}
              onChange={(event) => setListSort(event.target.value as ListSort)}
              className={`${isCompact ? "h-7 px-1.5 text-[11px]" : "h-8 px-2 text-xs"} border border-border bg-background text-foreground`}
            >
              <option value="updated_desc">Updated: newest first</option>
              <option value="updated_asc">Updated: oldest first</option>
              <option value="priority_desc">Priority: high to low</option>
              <option value="priority_asc">Priority: low to high</option>
              <option value="status">Status order</option>
            </select>
          </div>
          <div className="overflow-x-auto border border-border bg-card/65">
            <table className="min-w-full border-collapse text-left">
              <thead className="border-b border-border bg-secondary/35">
                <tr>
                  <TableHeaderCell isCompact={isCompact}>Task</TableHeaderCell>
                  <TableHeaderCell isCompact={isCompact}>Status</TableHeaderCell>
                  <TableHeaderCell isCompact={isCompact}>Priority</TableHeaderCell>
                  <TableHeaderCell isCompact={isCompact}>Owner</TableHeaderCell>
                  <TableHeaderCell isCompact={isCompact}>Updated</TableHeaderCell>
                </tr>
              </thead>
              <tbody>
                {listTasks.map((task) => (
                  <tr
                    key={task.id}
                    className="cursor-pointer border-b border-border/80 transition-colors hover:bg-accent/45"
                    onClick={() => onTaskClick(task.id)}
                  >
                    <td className={`px-3 ${isCompact ? "py-1" : "py-2.5"}`}>
                      <div
                        className={`${isCompact ? "text-[13px]" : "text-sm"} font-medium tracking-tight`}
                      >
                        {task.title}
                      </div>
                      {task.description && (
                        <div
                          className={`line-clamp-1 text-muted-foreground ${isCompact ? "text-[11px]" : "text-xs"}`}
                        >
                          {task.description}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 ${isCompact ? "py-1" : "py-2.5"}`}>
                      <span
                        className={`inline-flex border ${isCompact ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]"}`}
                        style={{
                          borderColor: `${STATUS_CONFIG[task.status].color}66`,
                          color: STATUS_CONFIG[task.status].color,
                          backgroundColor: `${STATUS_CONFIG[task.status].color}1A`,
                        }}
                      >
                        {STATUS_CONFIG[task.status].label}
                      </span>
                    </td>
                    <td
                      className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-[11px]" : "py-2.5 text-xs"}`}
                    >
                      {task.priority || "-"}
                    </td>
                    <td
                      className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-[11px]" : "py-2.5 text-xs"}`}
                    >
                      {task.autoMode ? "AI" : "Manual"}
                    </td>
                    <td
                      className={`px-3 text-muted-foreground ${isCompact ? "py-1 text-[11px]" : "py-2.5 text-xs"}`}
                    >
                      {new Date(task.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {listTasks.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-xs text-muted-foreground">
                      No tasks match current list search
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
