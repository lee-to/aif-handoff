import { useMemo, useState, useCallback } from "react";
import type { TaskListItem } from "@aif/shared/browser";

export type SortField = "updatedAt" | "priority" | "position" | "title";
export type SortDirection = "asc" | "desc";

export interface UseTaskFilteringOptions {
  defaultSort?: SortField;
  defaultDirection?: SortDirection;
}

export interface UseTaskFilteringResult {
  filteredTasks: TaskListItem[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortField: SortField;
  setSortField: (field: SortField) => void;
  sortDirection: SortDirection;
  setSortDirection: (direction: SortDirection) => void;
  activeFilters: string[];
  toggleFilter: (tag: string) => void;
  clearFilters: () => void;
}

export function useTaskFiltering(
  tasks: TaskListItem[],
  options?: UseTaskFilteringOptions,
): UseTaskFilteringResult {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>(options?.defaultSort ?? "updatedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    options?.defaultDirection ?? "desc",
  );
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  const toggleFilter = useCallback((tag: string) => {
    setActiveFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  const clearFilters = useCallback(() => {
    setActiveFilters([]);
  }, []);

  const filteredTasks = useMemo(() => {
    let result = tasks;

    // Filter by search query (title, description)
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(
        (task) =>
          task.title.toLowerCase().includes(query) ||
          (task.description ?? "").toLowerCase().includes(query),
      );
    }

    // Filter by active tag filters
    if (activeFilters.length > 0) {
      result = result.filter((task) => activeFilters.every((tag) => task.tags?.includes(tag)));
    }

    // Sort
    const sorted = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "updatedAt":
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
        case "priority":
          cmp = a.priority - b.priority;
          break;
        case "position":
          cmp = a.position - b.position;
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });

    return sorted;
  }, [tasks, searchQuery, activeFilters, sortField, sortDirection]);

  return {
    filteredTasks,
    searchQuery,
    setSearchQuery,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    activeFilters,
    toggleFilter,
    clearFilters,
  };
}
