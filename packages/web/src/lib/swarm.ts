import type { SwarmEvent, SwarmTask } from "@aif/shared/browser";

export class SwarmReplayGapError extends Error {}

export class SwarmEventBuffer {
  after = 0;
  events: SwarmEvent[] = [];
  constructor(private readonly runId: string) {}

  reset(after: number) {
    this.after = after;
    this.events = [];
  }

  accept(event: SwarmEvent): boolean {
    if (event.run_id !== this.runId) throw new SwarmReplayGapError("Foreign run event");
    if (event.sequence <= this.after) return false;
    if (
      event.sequence !== this.after + 1 ||
      this.events.some((entry) => entry.event_id === event.event_id)
    ) {
      throw new SwarmReplayGapError("Event history must be reconciled");
    }
    this.after = event.sequence;
    this.events = [...this.events.slice(-499), event];
    return true;
  }
}

export function swarmRetryDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function swarmTaskLayers(tasks: SwarmTask[]): { layers: SwarmTask[][]; cyclic: boolean } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const incoming = new Map(
    tasks.map((task) => [task.id, task.depends_on.filter((id) => byId.has(id)).length]),
  );
  const children = new Map<string, string[]>();
  for (const task of tasks)
    for (const id of task.depends_on) {
      const siblings = children.get(id);
      if (siblings) siblings.push(task.id);
      else children.set(id, [task.id]);
    }
  let ready = tasks.filter((task) => incoming.get(task.id) === 0);
  const layers: SwarmTask[][] = [];
  let visited = 0;
  while (ready.length) {
    layers.push(ready);
    visited += ready.length;
    const next: SwarmTask[] = [];
    for (const task of ready)
      for (const id of children.get(task.id) ?? []) {
        const remaining = (incoming.get(id) ?? 0) - 1;
        incoming.set(id, remaining);
        if (remaining === 0) next.push(byId.get(id)!);
      }
    ready = next;
  }
  return { layers, cyclic: visited !== tasks.length };
}

export function swarmTaskHierarchy(tasks: SwarmTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, SwarmTask[]>();
  for (const task of tasks)
    if (task.parent_id) {
      const siblings = children.get(task.parent_id);
      if (siblings) siblings.push(task);
      else children.set(task.parent_id, [task]);
    }
  const result: { task: SwarmTask; ancestors: string[]; hasChildren: boolean }[] = [];
  const seen = new Set<string>();
  const append = (roots: SwarmTask[]) => {
    const stack = [...roots].reverse().map((task) => ({ task, ancestors: [] as string[] }));
    while (stack.length) {
      const entry = stack.pop()!;
      if (seen.has(entry.task.id)) continue;
      seen.add(entry.task.id);
      const nested = children.get(entry.task.id) ?? [];
      result.push({ ...entry, hasChildren: nested.length > 0 });
      for (const task of [...nested].reverse())
        stack.push({ task, ancestors: [...entry.ancestors, entry.task.id] });
    }
  };
  append(tasks.filter((task) => !task.parent_id || !byId.has(task.parent_id)));
  append(tasks.filter((task) => !seen.has(task.id)));
  return result;
}
