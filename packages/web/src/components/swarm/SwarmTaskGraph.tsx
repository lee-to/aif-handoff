import { useState } from "react";
import type { SwarmTask } from "@aif/shared/browser";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import { swarmTaskHierarchy, swarmTaskLayers } from "@/lib/swarm";

export function SwarmTaskGraph({ tasks }: { tasks: SwarmTask[] }) {
  const [relation, setRelation] = useState("dependencies");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const matches = (task: SwarmTask) =>
    (!status || task.status === status) &&
    `${task.id} ${task.title}`.toLowerCase().includes(search.toLowerCase());
  // shortcut: render at most 200 graph nodes; add viewport virtualization when larger filtered graphs are needed.
  const visible = tasks.filter(matches).slice(0, 200);
  const hierarchy = swarmTaskHierarchy(visible);
  const graph = swarmTaskLayers(visible);
  const positions = new Map(
    graph.layers.flatMap((layer, column) =>
      layer.map((task, row) => [task.id, { x: column * 250 + 10, y: row * 90 + 10 }] as const),
    ),
  );
  const selected = tasks.find((task) => task.id === selectedId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search graph tasks"
          placeholder="Search tasks"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <Select
          value={status}
          options={[
            { value: "", label: "All statuses" },
            ...Array.from(new Set(tasks.map((task) => task.status))).map((value) => ({
              value,
              label: value,
            })),
          ]}
          onChange={(event) => setStatus(event.target.value)}
        />
        <Tabs
          items={[
            { value: "dependencies", label: "Dependencies" },
            { value: "hierarchy", label: "Parent–child" },
          ]}
          value={relation}
          onValueChange={setRelation}
        />
      </div>
      {relation === "dependencies" ? (
        <>
          <p className="text-xs text-muted-foreground">
            Arrows point from a prerequisite to the task that depends on it. Select a task for its
            result.
          </p>
          {graph.cyclic && (
            <p role="alert" className="text-destructive">
              Runtime reported a dependency cycle.
            </p>
          )}
          <div className="overflow-auto border border-border bg-card">
            <svg
              role="group"
              aria-label="Task dependency graph"
              width={Math.max(250, graph.layers.length * 250)}
              height={Math.max(110, ...graph.layers.map((layer) => layer.length * 90 + 10))}
            >
              <defs>
                <marker
                  id="swarm-arrow"
                  markerWidth="6"
                  markerHeight="6"
                  refX="6"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6" fill="currentColor" className="text-muted-foreground" />
                </marker>
              </defs>
              {visible.flatMap((task) =>
                task.depends_on.map((dependency) => {
                  const from = positions.get(dependency);
                  const to = positions.get(task.id);
                  return from && to ? (
                    <path
                      key={`${dependency}-${task.id}`}
                      d={`M${from.x + 210},${from.y + 32} C${from.x + 235},${from.y + 32} ${to.x - 25},${to.y + 32} ${to.x},${to.y + 32}`}
                      fill="none"
                      stroke="currentColor"
                      className="text-muted-foreground"
                      markerEnd="url(#swarm-arrow)"
                    />
                  ) : null;
                }),
              )}
              {visible.map((task) => {
                const position = positions.get(task.id);
                return position ? (
                  <g
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${task.id}: ${task.title}`}
                    onClick={() => setSelectedId(task.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(task.id);
                      }
                    }}
                    className="cursor-pointer text-foreground outline-primary"
                  >
                    <title>{task.title}</title>
                    <rect
                      x={position.x}
                      y={position.y}
                      width={210}
                      height={64}
                      fill="currentColor"
                      className="text-card"
                    />
                    <rect
                      x={position.x}
                      y={position.y}
                      width={210}
                      height={64}
                      fill="none"
                      stroke="currentColor"
                      className={selectedId === task.id ? "text-primary" : "text-border"}
                    />
                    <text x={position.x + 10} y={position.y + 22} fill="currentColor" fontSize={11}>
                      {task.title.slice(0, 27)}
                    </text>
                    <text
                      x={position.x + 10}
                      y={position.y + 44}
                      fill="currentColor"
                      className="text-muted-foreground"
                      fontSize={10}
                    >
                      {task.status} · {task.agent_id ?? "unassigned"}
                    </text>
                  </g>
                ) : null;
              })}
            </svg>
          </div>
        </>
      ) : (
        <div className="max-h-[32rem] overflow-auto border border-border p-3">
          {hierarchy
            .filter(
              (entry) =>
                matches(entry.task) && (search || !entry.ancestors.some((id) => collapsed.has(id))),
            )
            .slice(0, 200)
            .map(({ task, ancestors, hasChildren }) => (
              <div
                key={task.id}
                className="flex items-center gap-2 border-b border-border py-2"
                style={{ paddingLeft: Math.min(ancestors.length, 12) * 16 }}
              >
                {hasChildren && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Toggle children of ${task.id}`}
                    aria-expanded={!collapsed.has(task.id)}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(task.id)) next.delete(task.id);
                        else next.add(task.id);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(task.id) ? "+" : "−"}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setSelectedId(task.id)}>
                  {task.title}
                </Button>
                <span className="text-xs text-muted-foreground">{task.status}</span>
              </div>
            ))}
        </div>
      )}
      {tasks.filter(matches).length > 200 && (
        <p className="text-xs text-muted-foreground">
          Showing 200 tasks. Narrow the search or status filter.
        </p>
      )}
      {selected && (
        <Card className="space-y-2 text-sm">
          <h3 className="font-semibold">
            {selected.id}: {selected.title}
          </h3>
          <p>
            {selected.status} · Agent: {selected.agent_id ?? "unassigned"} · Duration:{" "}
            {selected.duration_ms === null
              ? "unknown"
              : `${Math.round(selected.duration_ms / 1000)}s`}
          </p>
          <p>
            Parent: {selected.parent_id ?? "none"} · Depends on:{" "}
            {selected.depends_on.join(", ") || "none"}
          </p>
          {selected.blocked_reason && <p className="text-destructive">{selected.blocked_reason}</p>}
          <p>{selected.result ?? "No result yet"}</p>
          <p className="break-all">Git: {selected.git_ref ?? "No ref yet"}</p>
          <pre className="whitespace-pre-wrap break-words text-xs">
            {selected.tests.join("\n") || "No test results yet"}
          </pre>
        </Card>
      )}
    </div>
  );
}
