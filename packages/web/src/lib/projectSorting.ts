import type { Project, ProjectTaskOverview } from "@aif/shared/browser";

export type ProjectSort = "name" | "lastActivity" | "activeTasks";

export const PROJECT_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "lastActivity", label: "Last activity" },
  { value: "activeTasks", label: "Active tasks" },
] satisfies { value: ProjectSort; label: string }[];

const projectNameCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function compareNullableDescending(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return right.localeCompare(left);
}

export function sortProjects(
  projects: Project[],
  sort: ProjectSort,
  overviewByProjectId: ReadonlyMap<string, ProjectTaskOverview>,
): Project[] {
  return [...projects].sort((left, right) => {
    const leftPinned = left.pinnedAt != null;
    const rightPinned = right.pinnedAt != null;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned && left.pinnedAt !== right.pinnedAt) {
      return (left.pinnedAt ?? "").localeCompare(right.pinnedAt ?? "");
    }

    if (sort === "lastActivity") {
      const activityOrder = compareNullableDescending(
        overviewByProjectId.get(left.id)?.lastActivityAt ?? null,
        overviewByProjectId.get(right.id)?.lastActivityAt ?? null,
      );
      if (activityOrder !== 0) return activityOrder;
    }

    if (sort === "activeTasks") {
      const activeTaskOrder =
        (overviewByProjectId.get(right.id)?.activeTasks ?? 0) -
        (overviewByProjectId.get(left.id)?.activeTasks ?? 0);
      if (activeTaskOrder !== 0) return activeTaskOrder;
    }

    const nameOrder = projectNameCollator.compare(left.name, right.name);
    return nameOrder !== 0 ? nameOrder : left.id.localeCompare(right.id);
  });
}
