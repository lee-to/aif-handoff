export interface PlanTaskNode {
  number: number;
  description: string;
  phase: number;
  explicitDependencies: number[];
  completed: boolean;
}

export interface PlanLayerComputation {
  tasks: PlanTaskNode[];
  layers: number[][];
}

function extractDependencyNumbers(raw: string): number[] {
  const nums = raw.match(/\d+/g) ?? [];
  const unique = Array.from(new Set(nums.map((value) => Number(value)).filter(Number.isFinite)));
  return unique.sort((a, b) => a - b);
}

function parseInlineTask(
  line: string
): { number: number; description: string; inlineDeps: number[]; completed: boolean } | null {
  const checkboxMatch = line.match(
    /^\s*-\s*\[([ x~!])\]\s+\*\*Task\s+(\d+):\s*([^*]+?)\*\*(?:\s*\(([^)]*)\))?/i
  );
  if (checkboxMatch) {
    const [, statusRaw, numberRaw, descRaw, depsRaw = ""] = checkboxMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: extractDependencyNumbers(depsRaw),
      completed: statusRaw.toLowerCase() === "x",
    };
  }

  const numberedCheckboxMatch = line.match(
    /^\s*(\d+)[.)]\s*\[([ x~!])\]\s+(.+?)(?:\s*\(([^)]*)\))?\s*$/i
  );
  if (numberedCheckboxMatch) {
    const [, numberRaw, statusRaw, descRaw, depsRaw = ""] = numberedCheckboxMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: extractDependencyNumbers(depsRaw),
      completed: statusRaw.toLowerCase() === "x",
    };
  }

  const numberedStepMatch = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
  if (numberedStepMatch) {
    const [, numberRaw, descRaw] = numberedStepMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: [],
      completed: false,
    };
  }

  const headingMatch = line.match(/^\s*###\s+Task\s+(\d+):\s*(.+)$/i);
  if (headingMatch) {
    const [, numberRaw, descRaw] = headingMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: [],
      completed: false,
    };
  }

  return null;
}

export function parsePlanTasks(planText: string): PlanTaskNode[] {
  const lines = planText.split("\n");
  const tasksByNumber = new Map<number, PlanTaskNode>();
  const phaseOrder: number[] = [];
  let currentPhase = 0;
  let currentTaskNumber: number | null = null;

  for (const line of lines) {
    if (/^\s*###\s+Phase\b/i.test(line) || /^\s*##\s+Phase\b/i.test(line)) {
      currentPhase += 1;
      continue;
    }

    const taskMatch = parseInlineTask(line);
    if (taskMatch) {
      const phase = currentPhase;
      const existing = tasksByNumber.get(taskMatch.number);
      const explicitDependencies = new Set(taskMatch.inlineDeps);

      if (existing) {
        for (const dep of existing.explicitDependencies) explicitDependencies.add(dep);
      }

      tasksByNumber.set(taskMatch.number, {
        number: taskMatch.number,
        description: taskMatch.description,
        phase,
        explicitDependencies: Array.from(explicitDependencies).sort((a, b) => a - b),
        completed: taskMatch.completed,
      });
      currentTaskNumber = taskMatch.number;
      phaseOrder.push(phase);
      continue;
    }

    if (currentTaskNumber == null) continue;

    const normalizedLine = line.replace(/\*/g, "");
    const depLine = normalizedLine.match(/depends on\s*:?\s*(.+)$/i);
    if (!depLine) continue;

    const deps = extractDependencyNumbers(depLine[1]);
    if (deps.length === 0) continue;
    const node = tasksByNumber.get(currentTaskNumber);
    if (!node) continue;
    const merged = Array.from(new Set([...node.explicitDependencies, ...deps])).sort((a, b) => a - b);
    tasksByNumber.set(currentTaskNumber, { ...node, explicitDependencies: merged });
  }

  if (tasksByNumber.size === 0) return [];

  const tasks = Array.from(tasksByNumber.values()).sort((a, b) => a.number - b.number);
  const knownNumbers = new Set(tasks.map((task) => task.number));

  // If plan has no explicit "Phase" headings, keep implicit phase 0 for all tasks.
  const hasPhases = phaseOrder.some((phase) => phase > 0);
  const phaseByTask = new Map<number, number>();
  for (const task of tasks) {
    phaseByTask.set(task.number, hasPhases ? task.phase : 0);
  }

  const normalized: PlanTaskNode[] = tasks.map((task) => {
    const explicitDependencies = task.explicitDependencies.filter(
      (dep) => dep !== task.number && knownNumbers.has(dep)
    );
    return {
      ...task,
      phase: phaseByTask.get(task.number) ?? 0,
      explicitDependencies,
      completed: task.completed,
    };
  });

  return normalized;
}

function buildResolvedDependencies(tasks: PlanTaskNode[]): Map<number, Set<number>> {
  const byPhase = new Map<number, number[]>();
  for (const task of tasks) {
    const list = byPhase.get(task.phase) ?? [];
    list.push(task.number);
    byPhase.set(task.phase, list);
  }

  const sortedPhases = Array.from(byPhase.keys()).sort((a, b) => a - b);
  const depsByTask = new Map<number, Set<number>>();
  const priorPhasesTasks: number[] = [];

  for (const phase of sortedPhases) {
    const taskNumbers = byPhase.get(phase) ?? [];
    for (const taskNumber of taskNumbers) {
      const task = tasks.find((item) => item.number === taskNumber);
      if (!task) continue;
      if (task.explicitDependencies.length > 0) {
        depsByTask.set(task.number, new Set(task.explicitDependencies));
      } else {
        depsByTask.set(task.number, new Set(priorPhasesTasks));
      }
    }
    priorPhasesTasks.push(...taskNumbers);
  }

  return depsByTask;
}

export function computeExecutionLayers(tasks: PlanTaskNode[]): number[][] {
  if (tasks.length === 0) return [];
  const depsByTask = buildResolvedDependencies(tasks);
  const remaining = new Set(tasks.map((task) => task.number));
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const ready: number[] = [];
    for (const taskNumber of remaining) {
      const deps = depsByTask.get(taskNumber) ?? new Set<number>();
      const isReady = Array.from(deps).every((dep) => !remaining.has(dep));
      if (isReady) ready.push(taskNumber);
    }

    if (ready.length === 0) {
      // Cyclic/invalid dependencies: fallback to deterministic single-task drain.
      const fallback = Array.from(remaining).sort((a, b) => a - b)[0];
      layers.push([fallback]);
      remaining.delete(fallback);
      continue;
    }

    ready.sort((a, b) => a - b);
    layers.push(ready);
    for (const taskNumber of ready) remaining.delete(taskNumber);
  }

  return layers;
}

export function computePlanLayers(planText: string): PlanLayerComputation {
  const tasks = parsePlanTasks(planText);
  const layers = computeExecutionLayers(tasks);
  return { tasks, layers };
}

export function computePendingPlanLayers(planText: string): PlanLayerComputation {
  const allTasks = parsePlanTasks(planText);
  const completedNumbers = new Set(
    allTasks.filter((task) => task.completed).map((task) => task.number)
  );
  const pendingTasks = allTasks
    .filter((task) => !task.completed)
    .map((task) => ({
      ...task,
      explicitDependencies: task.explicitDependencies.filter((dep) => !completedNumbers.has(dep)),
    }));
  const layers = computeExecutionLayers(pendingTasks);
  return { tasks: pendingTasks, layers };
}

export function formatLayerSummary(layers: number[][]): string {
  if (layers.length === 0) return "No parsed execution layers were detected.";
  return layers
    .map((layer, index) => {
      const mode = layer.length > 1 ? "parallel" : "sequential";
      return `Layer ${index + 1} (${mode}): tasks ${layer.join(", ")}`;
    })
    .join("\n");
}
