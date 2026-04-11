import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { logger, getEnv, getProjectConfig, generatePlanPath } from "@aif/shared";
import {
  createTask,
  findProjectById,
  findTasksByRoadmapAlias,
  incrementTaskTokenUsage,
  listTasks,
} from "@aif/data";
import { resolveApiLightModel, runApiRuntimeOneShot } from "./runtime.js";

const log = logger("roadmap-generation");

// -- Zod schemas for agent response validation --

const generatedTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().default(""),
  phase: z.number().int().min(1),
  phaseName: z.string().default(""),
  sequence: z.number().int().min(1),
});

const roadmapResponseSchema = z.object({
  alias: z.string().min(1).max(200),
  tasks: z.array(generatedTaskSchema).min(1),
});

export type GeneratedTask = z.infer<typeof generatedTaskSchema>;
export type RoadmapResponse = z.infer<typeof roadmapResponseSchema>;

export interface RoadmapGenerationInput {
  projectId: string;
  roadmapAlias: string;
  /** Optional task ID for tracking token usage */
  trackingTaskId?: string;
}

export interface RoadmapGenerationResult {
  alias: string;
  tasks: GeneratedTask[];
}

export interface GenerateRoadmapFileInput {
  projectId: string;
  /** Optional user-provided vision/requirements to guide generation */
  vision?: string;
}

export interface GenerateRoadmapFileResult {
  roadmapPath: string;
  content: string;
}

/**
 * Generate a ROADMAP.md file for the project using Agent SDK.
 * Reads DESCRIPTION.md and ARCHITECTURE.md for context, then produces
 * a strategic milestone roadmap.
 */
/** Extract roadmap content from agent outputText, stripping markdown fences if present. */
function extractRoadmapContent(raw: string): string {
  const fenceMatch = raw.match(/```(?:markdown)?\s*\n([\s\S]*?)\n\s*```/);
  return fenceMatch ? fenceMatch[1].trim() : raw.trim();
}

export async function generateRoadmapFile(
  input: GenerateRoadmapFileInput,
): Promise<GenerateRoadmapFileResult> {
  const { projectId, vision } = input;

  log.info({ projectId }, "Starting roadmap file generation");

  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }

  // Read project context
  const projectCfg = getProjectConfig(project.rootPath);
  const descriptionPath = join(project.rootPath, projectCfg.paths.description);
  const architecturePath = join(project.rootPath, projectCfg.paths.architecture);

  const description = existsSync(descriptionPath) ? readFileSync(descriptionPath, "utf8") : null;
  const architecture = existsSync(architecturePath) ? readFileSync(architecturePath, "utf8") : null;

  if (!description && !vision) {
    throw new RoadmapGenerationError(
      "NO_CONTEXT",
      "No DESCRIPTION.md found and no vision provided. Cannot generate roadmap without project context.",
    );
  }

  log.debug(
    {
      hasDescription: !!description,
      hasArchitecture: !!architecture,
      hasVision: !!vision,
    },
    "Project context loaded for roadmap generation",
  );

  const basePrompt = buildRoadmapGenerationPrompt({
    description,
    architecture,
    vision: vision ?? null,
  });
  let rawResult = "";
  try {
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      prompt: basePrompt,
      workflowKind: "roadmap-generate",
      systemPromptAppend:
        "Do not spawn subagents. Reply directly with the ROADMAP.md content in markdown format. No JSON, no code fences around the entire output.",
    });
    rawResult = (result.outputText ?? "").trim();
  } catch (err) {
    log.error({ err, projectId }, "Agent SDK roadmap generation error");
    throw new RoadmapGenerationError(
      "AGENT_UNAVAILABLE",
      `Agent SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Write ROADMAP.md — agent may have already written the file via tools (CLI mode),
  // so check the file first before falling back to outputText.
  const cfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, cfg.paths.roadmap);
  mkdirSync(dirname(roadmapPath), { recursive: true });

  let content: string;
  if (existsSync(roadmapPath)) {
    const fileContent = readFileSync(roadmapPath, "utf8").trim();
    // Verify agent wrote a real roadmap, not just a stub
    if (fileContent.length > 100 && (fileContent.includes("- [") || fileContent.includes("##"))) {
      content = fileContent;
      log.info({ projectId, roadmapPath, source: "file" }, "Using roadmap file written by agent");
    } else {
      content = extractRoadmapContent(rawResult);
      writeFileSync(roadmapPath, content, "utf8");
    }
  } else if (rawResult) {
    content = extractRoadmapContent(rawResult);
    writeFileSync(roadmapPath, content, "utf8");
  } else {
    throw new RoadmapGenerationError("EMPTY_RESPONSE", "Agent returned empty roadmap");
  }

  log.info({ projectId, roadmapPath, contentLength: content.length }, "Roadmap file generated");

  return { roadmapPath, content };
}

function buildRoadmapGenerationPrompt(ctx: {
  description: string | null;
  architecture: string | null;
  vision: string | null;
}): string {
  const sections: string[] = [];

  if (ctx.description) {
    sections.push(`PROJECT DESCRIPTION:\n<<<DESC\n${ctx.description}\nDESC`);
  }
  if (ctx.architecture) {
    sections.push(`ARCHITECTURE:\n<<<ARCH\n${ctx.architecture}\nARCH`);
  }
  if (ctx.vision) {
    sections.push(`USER VISION / REQUIREMENTS:\n<<<VISION\n${ctx.vision}\nVISION`);
  }

  return `You are creating a strategic project roadmap based on the project context below.

${sections.join("\n\n")}

Generate a ROADMAP.md file with the following format:

# Project Roadmap

> <one-line project vision>

## Milestones

- [ ] **Milestone Name** — short description of what this achieves
- [ ] **Milestone Name** — short description of what this achieves

## Completed

| Milestone | Date |
|-----------|------|

Rules:
- Each milestone is a HIGH-LEVEL goal, not a granular task
- 5-15 milestones is the sweet spot
- Order by logical sequence (dependencies first)
- If something appears already built based on the description, mark it [x] and add to Completed table with today's date
- Milestones should be specific and actionable, not vague
- Cover the full scope of the project from current state to production-ready
- Output ONLY the markdown content for ROADMAP.md, nothing else`;
}

/**
 * Read ROADMAP.md from the project root and use Agent SDK to extract
 * structured task data as JSON. Validates the result via zod.
 */
export async function generateRoadmapTasks(
  input: RoadmapGenerationInput,
): Promise<RoadmapGenerationResult> {
  const { projectId, roadmapAlias, trackingTaskId } = input;

  log.info({ projectId, roadmapAlias }, "Starting roadmap generation");

  // 1. Resolve project root and verify roadmap file
  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }

  const tasksCfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, tasksCfg.paths.roadmap);
  if (!existsSync(roadmapPath)) {
    throw new RoadmapGenerationError(
      "ROADMAP_NOT_FOUND",
      `Roadmap file not found at ${roadmapPath}`,
    );
  }

  const roadmapContent = readFileSync(roadmapPath, "utf8");
  log.debug({ roadmapPath, contentLength: roadmapContent.length }, "Roadmap file read");

  // 2. Query Agent SDK for strict JSON conversion
  const prompt = buildExtractionPrompt(roadmapContent, roadmapAlias);

  let rawResult = "";
  try {
    const lightModel = await resolveApiLightModel(projectId, trackingTaskId);
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      taskId: trackingTaskId ?? null,
      prompt,
      workflowKind: "roadmap-extract",
      modelOverride: lightModel,
      systemPromptAppend:
        "Do not spawn subagents. Reply directly with JSON only. No markdown fences, no explanatory text.",
    });

    if (trackingTaskId && result.usage) {
      incrementTaskTokenUsage(trackingTaskId, {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
        total_cost_usd: result.usage.costUsd,
      });
    }

    rawResult = (result.outputText ?? "").trim();
  } catch (err) {
    log.error({ err, projectId, roadmapAlias }, "Agent SDK query error");
    throw new RoadmapGenerationError(
      "AGENT_UNAVAILABLE",
      `Agent SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.debug({ rawResultLength: rawResult.length }, "Raw agent output received");

  if (!rawResult) {
    throw new RoadmapGenerationError("EMPTY_RESPONSE", "Agent returned empty response");
  }

  // 3. Parse and validate response
  const parsed = parseAgentResponse(rawResult, roadmapAlias);
  log.info(
    { projectId, roadmapAlias, taskCount: parsed.tasks.length },
    "Roadmap generation complete",
  );

  return parsed;
}

function buildExtractionPrompt(roadmapContent: string, alias: string): string {
  return `You are converting a project roadmap markdown into structured JSON for task creation.

ROADMAP CONTENT:
<<<ROADMAP
${roadmapContent}
ROADMAP

ALIAS: ${alias}

Convert all milestones/tasks from the roadmap into the following JSON structure.
Each item becomes a task. Group by phase (numbered sequentially from 1).
Assign each task a sequence number within its phase (starting from 1).

Required output format (JSON only, no markdown fences):
{
  "alias": "${alias}",
  "tasks": [
    {
      "title": "short imperative task title",
      "description": "detailed description of what needs to be done",
      "phase": 1,
      "phaseName": "Phase Name",
      "sequence": 1
    }
  ]
}

Rules:
- Only include unchecked milestones (- [ ]). Skip completed milestones (- [x]) entirely — do NOT create tasks for them
- Task titles should be short, imperative, and specific
- Descriptions should include enough context for implementation
- Phase numbers must be sequential (1, 2, 3, ...)
- Sequence numbers restart at 1 for each phase
- Return ONLY valid JSON, no explanatory text`;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAgentResponse(raw: string, expectedAlias: string): RoadmapGenerationResult {
  // Extract JSON from markdown fences — agent may include extra text after the closing fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let jsonObj: unknown;
  try {
    jsonObj = JSON.parse(cleaned);
  } catch (initialErr) {
    // Fallback: agent may have prepended prose before the JSON object
    const extracted = extractJsonObject(cleaned);
    if (extracted) {
      try {
        jsonObj = JSON.parse(extracted);
      } catch (err) {
        log.error({ raw: raw.slice(0, 500), err }, "Failed to parse agent response as JSON");
        throw new RoadmapGenerationError(
          "PARSE_ERROR",
          `Agent response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      log.error(
        { raw: raw.slice(0, 500), err: initialErr },
        "Failed to parse agent response as JSON",
      );
      throw new RoadmapGenerationError(
        "PARSE_ERROR",
        `Agent response is not valid JSON: ${initialErr instanceof Error ? initialErr.message : String(initialErr)}`,
      );
    }
  }

  const validated = roadmapResponseSchema.safeParse(jsonObj);
  if (!validated.success) {
    log.error(
      { issues: validated.error.issues, raw: raw.slice(0, 500) },
      "Agent response failed zod validation",
    );
    throw new RoadmapGenerationError(
      "VALIDATION_ERROR",
      `Response validation failed: ${validated.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  // Normalize alias to match input
  return {
    alias: expectedAlias,
    tasks: validated.data.tasks,
  };
}

// -- Tag enrichment --

/**
 * Build the required tag set for a generated roadmap task.
 * Tags: roadmap, rm:<alias>, phase:<number>, phase:<name>, seq:<nn>
 */
export function buildTaskTags(alias: string, task: GeneratedTask): string[] {
  const tags: string[] = ["roadmap", `rm:${alias}`];
  tags.push(`phase:${task.phase}`);
  if (task.phaseName) {
    tags.push(`phase:${task.phaseName.toLowerCase().replace(/\s+/g, "-")}`);
  }
  tags.push(`seq:${String(task.sequence).padStart(2, "0")}`);
  return tags;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

// -- Dedupe + batch creation --

export interface ImportResult {
  roadmapAlias: string;
  created: number;
  skipped: number;
  taskIds: string[];
  byPhase: Record<number, { created: number; skipped: number }>;
}

/**
 * Import generated tasks into the database, deduplicating by
 * projectId + normalizedTitle + roadmapAlias.
 */
export function importGeneratedTasks(
  projectId: string,
  generation: RoadmapGenerationResult,
): ImportResult {
  const { alias, tasks: generatedTasks } = generation;

  log.info({ projectId, alias, totalTasks: generatedTasks.length }, "Starting task import");

  // Resolve project config so every imported task gets a unique slug-based
  // planPath. Without this each task would fall back to the shared default
  // `cfg.paths.plan` and overwrite the previous task's plan on disk
  // (see lee-to/aif-handoff#55). planPath is decoupled from plannerMode here:
  // the task keeps whatever planner mode the project defaults to, we only
  // ensure the plan file path itself is unique for bulk imports.
  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }
  const cfg = getProjectConfig(project.rootPath);

  // Load existing tasks for this alias for dedupe
  const existing = findTasksByRoadmapAlias(projectId, alias);
  const existingTitles = new Set(existing.map((t) => normalizeTitle(t.title)));

  // Reserve every planPath already used by any task in this project (across
  // all aliases), so collision suffixes don't accidentally overwrite an
  // existing plan file. The shared default is excluded because it's not
  // owned by any single task and stays safe to collide against.
  const usedPlanPaths = new Set<string>(
    listTasks(projectId)
      .map((t) => t.planPath)
      .filter((p): p is string => !!p && p !== cfg.paths.plan),
  );

  // Compute a unique plan path per task using the shared slug helper, and
  // append `-2`, `-3`, … before `.md` if the base path collides with an
  // already-reserved one. This covers both intra-batch collisions (two titles
  // slugifying to the same string) and cross-import collisions (repeat
  // imports or different aliases hitting the same slug).
  const reserveUniquePlanPath = (title: string): string => {
    const base = generatePlanPath(title, "full", {
      plansDir: cfg.paths.plans,
      defaultPlanPath: cfg.paths.plan,
    });
    if (!usedPlanPaths.has(base)) {
      usedPlanPaths.add(base);
      return base;
    }
    const suffixMatch = base.match(/^(.*)\.md$/);
    const stem = suffixMatch ? suffixMatch[1] : base;
    let counter = 2;
    let candidate = `${stem}-${counter}.md`;
    while (usedPlanPaths.has(candidate)) {
      counter++;
      candidate = `${stem}-${counter}.md`;
    }
    usedPlanPaths.add(candidate);
    return candidate;
  };

  const result: ImportResult = {
    roadmapAlias: alias,
    created: 0,
    skipped: 0,
    taskIds: [],
    byPhase: {},
  };

  for (const genTask of generatedTasks) {
    const phaseStats = result.byPhase[genTask.phase] ?? { created: 0, skipped: 0 };
    result.byPhase[genTask.phase] = phaseStats;

    const normalized = normalizeTitle(genTask.title);
    if (existingTitles.has(normalized)) {
      log.debug({ title: genTask.title, alias, phase: genTask.phase }, "Task skipped (duplicate)");
      phaseStats.skipped++;
      result.skipped++;
      continue;
    }

    const tags = buildTaskTags(alias, genTask);
    // "full" here is just the path-shape selector (`<plansDir>/<slug>.md`),
    // NOT a planner-mode override — plannerMode is left untouched so the
    // project/task defaults still apply (fast for regular projects,
    // parallelEnabled projects already force full via POST /tasks).
    const planPath = reserveUniquePlanPath(genTask.title);
    const created = createTask({
      projectId,
      title: genTask.title,
      description: genTask.description,
      roadmapAlias: alias,
      tags,
      planPath,
      useSubagents: getEnv().AGENT_USE_SUBAGENTS,
    });

    if (created) {
      result.taskIds.push(created.id);
      phaseStats.created++;
      result.created++;
      existingTitles.add(normalized);
    }
  }

  log.info(
    {
      projectId,
      alias,
      created: result.created,
      skipped: result.skipped,
    },
    "Task import complete with distinct plan paths",
  );

  return result;
}

export class RoadmapGenerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoadmapGenerationError";
  }
}
