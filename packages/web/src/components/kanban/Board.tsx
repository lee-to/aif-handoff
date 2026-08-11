import { useEffect, useMemo, useState } from "react";
import {
  ORDERED_STATUSES,
  STATUS_CONFIG,
  type TaskListItem,
  type TaskStatus,
} from "@aif/shared/browser";
import { useTasks } from "@/hooks/useTasks";
import { Column } from "./Column";
import { Button } from "@/components/ui/button";
import { AddTaskForm } from "./AddTaskForm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { readStorage, writeStorage } from "@/lib/storage";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { FilterBar, type QuickFilter } from "./FilterBar";
import { TaskListTable } from "./TaskListTable";
import { useAuth } from "@/hooks/useAuth";

type ViewMode = "kanban" | "list";
type ListSort = "updated_desc" | "updated_asc" | "priority_desc" | "priority_asc" | "status";

interface BoardProps {
  projectId: string;
  onTaskClick: (taskId: string) => void;
  density: "comfortable" | "compact";
  viewMode?: ViewMode;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_CUTOFF_REFERENCE_TS = Date.now();
const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "verified"]);

const STATUS_ORDER = Object.fromEntries(
  ORDERED_STATUSES.map((status, idx) => [status, idx]),
) as Record<TaskStatus, number>;

function compareByPositionThenId(a: TaskListItem, b: TaskListItem): number {
  const positionDiff = a.position - b.position;
  return positionDiff !== 0 ? positionDiff : a.id.localeCompare(b.id);
}

function compareTerminalTasks(a: TaskListItem, b: TaskListItem): number {
  const aUpdatedAt = new Date(a.updatedAt).getTime();
  const bUpdatedAt = new Date(b.updatedAt).getTime();
  const hasValidAUpdatedAt = Number.isFinite(aUpdatedAt);
  const hasValidBUpdatedAt = Number.isFinite(bUpdatedAt);

  if (hasValidAUpdatedAt !== hasValidBUpdatedAt) {
    return hasValidAUpdatedAt ? -1 : 1;
  }

  if (hasValidAUpdatedAt && hasValidBUpdatedAt) {
    const updatedAtDiff = bUpdatedAt - aUpdatedAt;
    if (updatedAtDiff !== 0) return updatedAtDiff;
  }

  return compareByPositionThenId(a, b);
}

export function Board({ projectId, onTaskClick, density, viewMode = "kanban" }: BoardProps) {
  const { data: tasks, isLoading } = useTasks(projectId);
  const { session } = useAuth();
  const currentParticipantId = session?.participant?.id ?? null;
  const isCompact = density === "compact";
  const [activeFilters, setActiveFilters] = useState<QuickFilter[]>([]);
  const [activeRoadmapAliases, setActiveRoadmapAliases] = useState<string[]>([]);
  const [activeAssigneeIds, setActiveAssigneeIds] = useState<string[]>([]);
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
      if (filter === "roadmap" && !next.includes("roadmap")) {
        setActiveRoadmapAliases([]);
      }
      if (filter === "human_owned" && !next.includes("human_owned")) {
        setActiveAssigneeIds([]);
      }
      return next;
    });
  };

  const toggleRoadmapAlias = (alias: string) => {
    setActiveRoadmapAliases((prev) =>
      prev.includes(alias) ? prev.filter((a) => a !== alias) : [...prev, alias],
    );
  };

  const toggleAssignee = (participantId: string) => {
    setActiveAssigneeIds((prev) => {
      const next = prev.includes(participantId)
        ? prev.filter((id) => id !== participantId)
        : [...prev, participantId];
      console.debug("[FIX:participant-assignee-filter] Assignee filter toggled", {
        participantId,
        active: next.includes(participantId),
      });
      return next;
    });
  };

  const assignees = useMemo(() => {
    const byId = new Map<string, { participantId: string; displayName: string }>();
    for (const task of tasks ?? []) {
      if (task.executionOwner !== "human") continue;
      for (const assignee of task.assignees) {
        byId.set(assignee.participantId, {
          participantId: assignee.participantId,
          displayName: assignee.displayName,
        });
      }
    }
    return [...byId.values()].sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) ||
        a.participantId.localeCompare(b.participantId),
    );
  }, [tasks]);

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
      if (
        activeFilters.includes("mine") &&
        (!currentParticipantId ||
          !task.assignees.some((assignee) => assignee.participantId === currentParticipantId))
      )
        return false;
      if (activeFilters.includes("human_owned") && task.executionOwner !== "human") return false;
      if (
        activeFilters.includes("human_owned") &&
        activeAssigneeIds.length > 0 &&
        !task.assignees.some((assignee) => activeAssigneeIds.includes(assignee.participantId))
      )
        return false;
      if (activeFilters.includes("ai_owned") && task.executionOwner !== "ai") return false;
      if (
        activeFilters.includes("unassigned") &&
        (task.executionOwner !== "human" || task.assignees.length > 0)
      )
        return false;
      if (activeFilters.includes("blocked") && task.status !== "blocked_external") return false;
      if (activeFilters.includes("recent")) {
        const updatedTs = new Date(task.updatedAt).getTime();
        const oneDayAgo = RECENT_CUTOFF_REFERENCE_TS - ONE_DAY_MS;
        if (updatedTs < oneDayAgo) return false;
      }
      if (activeFilters.includes("no_plan") && task.hasPlan) return false;
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
  }, [activeAssigneeIds, activeFilters, activeRoadmapAliases, currentParticipantId, tasks]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, TaskListItem[]> = {
      backlog: [],
      planning: [],
      improve: [],
      plan_ready: [],
      implementing: [],
      review: [],
      verify: [],
      blocked_external: [],
      done: [],
      verified: [],
    };

    for (const task of filteredTasks) {
      grouped[task.status]?.push(task);
    }

    for (const status of ORDERED_STATUSES) {
      grouped[status].sort(
        TERMINAL_STATUSES.has(status) ? compareTerminalTasks : compareByPositionThenId,
      );
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
      <FilterBar
        activeFilters={activeFilters}
        onToggleFilter={toggleFilter}
        onClearFilters={() => {
          setActiveFilters([]);
          setActiveRoadmapAliases([]);
          setActiveAssigneeIds([]);
        }}
        isCompact={isCompact}
        roadmapAliases={roadmapAliases}
        activeRoadmapAliases={activeRoadmapAliases}
        onToggleRoadmapAlias={toggleRoadmapAlias}
        assignees={assignees}
        activeAssigneeIds={activeAssigneeIds}
        onToggleAssignee={toggleAssignee}
      />

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
              onClick={() => {
                setActiveFilters([]);
                setActiveRoadmapAliases([]);
                setActiveAssigneeIds([]);
              }}
            >
              Show all tasks
            </Button>
          )}
        </div>
      )}

      {viewMode === "kanban" ? (
        <div data-testid="kanban-board" className="flex gap-4 overflow-x-auto pb-6">
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
              inputSize={isCompact ? "sm" : "default"}
              className="md:max-w-lg"
            />
            <Select
              value={listSort}
              onChange={(event) => setListSort(event.target.value as ListSort)}
              options={[
                { value: "updated_desc", label: "Updated: newest first" },
                { value: "updated_asc", label: "Updated: oldest first" },
                { value: "priority_desc", label: "Priority: high → low" },
                { value: "priority_asc", label: "Priority: low → high" },
                { value: "status", label: "Status order" },
              ]}
              selectSize={isCompact ? "sm" : "default"}
              className={isCompact ? "w-48" : "w-52"}
            />
          </div>
          <TaskListTable
            tasks={listTasks}
            isCompact={isCompact}
            onTaskClick={onTaskClick}
            onReorderBacklog={() => {
              if (listSort !== "status") setListSort("status");
            }}
          />
        </div>
      )}
    </>
  );
}
