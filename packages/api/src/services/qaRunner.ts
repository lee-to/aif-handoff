import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getProjectConfig, logger } from "@aif/shared";
import { findTaskById, updateTask } from "@aif/data";
import { RuntimeExecutionError, UsageSource } from "@aif/runtime";
import { runApiRuntimeOneShot } from "./runtime.js";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import { broadcast } from "../ws.js";

const log = logger("qa-runner");

export interface RunQaQueryResult {
  ok: boolean;
  error?: string;
  code?: "ai_handoff_required";
}

export interface RunQaQueryInput {
  projectId: string;
  taskId: string;
  /** Worktree-aware root (task.worktreePath ?? project.rootPath). */
  executionRoot: string;
}

/**
 * Deterministic, filesystem-safe, collision-resistant slug for QA artifacts.
 *
 * HARD CONTRACT with `.claude/skills/aif-qa/SKILL.md` (steps 84-93). If the
 * skill changes its slug algorithm, this function and the matching test in
 * `qaRunner.test.ts` MUST be updated in lockstep — otherwise the runner reads
 * from a different directory than the skill writes to and gets `null` artifacts.
 *
 * Algorithm:
 *  1. safe_slug — replace every char not in [A-Za-z0-9._-] with `-`, collapse
 *     repeated `-`, trim leading/trailing `-`, fall back to "branch", truncate
 *     to 40 chars.
 *  2. hash8 — first 8 hex chars of `git hash-object --stdin` over the ORIGINAL
 *     branch name (with a trailing newline, mirroring the skill's `<<<` here-string).
 *  3. combine — `<safe_slug>-<hash8>`.
 */
export function computeQaBranchSlug(branch: string, executionRoot: string): string {
  const safeSlug =
    branch
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "branch";

  // `<<< "<branch>"` appends a trailing newline; replicate it so the hash
  // matches the skill exactly (e.g. feature/foo -> a72ccce7).
  const hashOutput = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: executionRoot,
    input: `${branch}\n`,
    encoding: "utf-8",
  });
  const hash8 = hashOutput.trim().slice(0, 8);

  return `${safeSlug}-${hash8}`;
}

/**
 * Resolve the branch QA artifacts are keyed under. Mirrors the aif-qa skill's
 * Step 0.2 resolution: prefer the task's persisted branch, otherwise fall back
 * to the branch currently checked out in `executionRoot` (`git branch
 * --show-current`). Fast-mode tasks never persist a branchName — they run on the
 * project's current branch by design (planner.ts) — so without this fallback QA
 * would be a silent no-op for them. Returns "" on detached HEAD / non-git roots;
 * `computeQaBranchSlug` normalizes that to the "branch" slug, matching the skill.
 */
export function resolveQaBranch(persistedBranch: string | null, executionRoot: string): string {
  if (persistedBranch) return persistedBranch;
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: executionRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/** Build the explicit aif-qa pipeline prompt with absolute artifact paths baked in. */
export function buildQaPrompt(artifactDir: string): string {
  return [
    "You are running the aif-qa workflow in --all mode. Run the full QA pipeline for the",
    "current working branch and write THREE markdown artifacts to these EXACT absolute paths:",
    "",
    `  1. ${join(artifactDir, "change-summary.md")}`,
    `  2. ${join(artifactDir, "test-plan.md")}`,
    `  3. ${join(artifactDir, "test-cases.md")}`,
    "",
    "Pipeline stages (run all three in order, feeding each into the next):",
    "1. change-summary — analyze what changed on this branch vs the base, assess risk areas,",
    "   and produce a concise change summary. Write it to the change-summary.md path above.",
    "2. test-plan — derive a structured test plan from the change summary. Write it to the",
    "   test-plan.md path above.",
    "3. test-cases — expand the test plan into concrete, runnable test cases. Write it to the",
    "   test-cases.md path above.",
    "",
    "Hard rules:",
    "- Create the artifact directory if it does not exist before writing.",
    "- Write to the EXACT absolute paths listed above — do not invent your own directory.",
    "- Work strictly inside the current project root. Do not modify source code or run tests;",
    "  this is an analysis/planning pass that only writes the three markdown artifacts.",
  ].join("\n");
}

function readArtifact(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Single failure exit for runQaQuery: persist qaStatus:"error", broadcast the
 * update, and return the structured { ok:false } result. Shared by the
 * missing-artifact branch and the catch-all so neither re-implements error
 * handling — and so runQaQuery returns ok:false directly rather than throwing
 * to its own catch. Persistence is wrapped defensively: a DB failure here must
 * not mask the original error.
 */
function persistQaError(taskId: string, error: string): RunQaQueryResult {
  try {
    updateTask(taskId, { qaStatus: "error" });
    const errorTask = findTaskById(taskId);
    if (errorTask) {
      broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(errorTask) });
    }
  } catch (persistErr) {
    log.error({ persistErr, taskId }, "[QA] Failed to persist error status");
  }
  return { ok: false, error };
}

/**
 * Fire-and-forget worker: run the aif-qa pipeline via the shared runtime and
 * persist the three artifacts + a terminal qaStatus on the task. Mirrors
 * `runCommitQuery` (services/commitGeneration.ts) — returns a structured result
 * and NEVER throws. Broadcasts `task:updated` on completion so the UI picks up
 * qaStatus/artifacts without racing the qa_* events.
 *
 * PRECONDITION: the caller must have already claimed the run by transitioning
 * qaStatus to "running" (routes/tasks `startQaRun` → `tryStartQaRun`). This
 * worker does NOT set "running" itself — it only finalizes to "done" / "error"
 * — so the atomic claim stays the single point that serializes concurrent runs.
 */
export async function runQaQuery(input: RunQaQueryInput): Promise<RunQaQueryResult> {
  const { projectId, taskId, executionRoot } = input;

  const task = findTaskById(taskId);
  if (!task) {
    const msg = `Task not found: ${taskId}`;
    log.error({ taskId, projectId }, msg);
    return { ok: false, error: msg };
  }
  if (task.executionOwner === "human") {
    log.warn(
      { taskId, projectId, executionOwner: task.executionOwner },
      "[QA] Runtime rejected for human-owned task",
    );
    return {
      ok: false,
      code: "ai_handoff_required",
      error: "The task must be handed to AI before QA can run",
    };
  }

  // Branch/config/slug resolution lives INSIDE the try alongside the runtime
  // call so runQaQuery honors its "NEVER throws" contract. computeQaBranchSlug
  // runs `git hash-object` against executionRoot; a stale/missing root (e.g. a
  // deleted worktree) makes execFileSync throw synchronously. Without this guard
  // the throw would escape the route's fire-and-forget dispatch with no
  // task:qa_failed event and no persisted qaStatus:"error".
  try {
    // Resolve the QA branch the same way the aif-qa skill does (Step 0.2): the
    // task's persisted branch, or the current git branch as a fallback. This keeps
    // the runner's slug in lockstep with the skill so CLI/API transports agree on
    // the artifact directory even for branchless (fast-mode) tasks.
    const resolvedBranch = resolveQaBranch(task.branchName, executionRoot);

    // Resolve artifact paths deterministically BEFORE running the runtime so the
    // exact paths can be baked into the prompt (CLI resolves /aif-qa --all to its
    // own slug dir, but Codex-API/OpenRouter only execute the spelled-out prompt).
    const cfg = getProjectConfig(executionRoot);
    const qaRoot = join(executionRoot, cfg.paths.qa);
    const branchSlug = computeQaBranchSlug(resolvedBranch, executionRoot);
    const artifactDir = join(qaRoot, branchSlug);

    log.info(
      { taskId, branch: resolvedBranch, branchSource: task.branchName ? "task" : "git" },
      "[QA] Starting QA run",
    );
    log.debug(
      { taskId, executionRoot, qaRoot, branchSlug, artifactDir },
      "[QA] Resolved artifact dir",
    );

    // qaStatus is already "running": the caller (routes/tasks startQaRun) claims
    // the slot atomically via tryStartQaRun BEFORE dispatching this worker, which
    // is what makes concurrent starts mutually exclusive. This worker only
    // finalizes the run to "done" / "error".
    const prompt = buildQaPrompt(artifactDir);

    const executionBoundaryTask = findTaskById(taskId);
    if (!executionBoundaryTask || executionBoundaryTask.executionOwner === "human") {
      return {
        ok: false,
        code: "ai_handoff_required",
        error: "The task must be handed to AI before QA can run",
      };
    }
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: executionRoot,
      taskId,
      prompt,
      workflowKind: "qa",
      fallbackSlashCommand: "/aif-qa --all",
      usageContext: { source: UsageSource.QA },
    });

    log.info(
      { taskId, artifactDir, outputPreview: result.outputText?.slice(0, 200) ?? "" },
      "[QA] Reading artifacts from artifact dir",
    );

    const qaChangeSummary = readArtifact(join(artifactDir, "change-summary.md"));
    const qaTestPlan = readArtifact(join(artifactDir, "test-plan.md"));
    const qaTestCases = readArtifact(join(artifactDir, "test-cases.md"));

    // A successful QA run is defined as producing ALL THREE artifacts. If the
    // runtime finished but one or more files are missing (null), fail the run
    // rather than persisting a misleading qaStatus:"done" with gaps. This is a
    // validation failure (not a runtime exception), so we return ok:false
    // directly with an actionable message — no throwing to our own catch.
    const missingArtifacts = (
      [
        ["change-summary.md", qaChangeSummary],
        ["test-plan.md", qaTestPlan],
        ["test-cases.md", qaTestCases],
      ] as const
    )
      .filter(([, content]) => content === null)
      .map(([name]) => name);
    if (missingArtifacts.length > 0) {
      const msg = `QA run did not produce required artifact(s): ${missingArtifacts.join(", ")}`;
      log.error({ taskId, artifactDir, missingArtifacts }, `[QA] ${msg}`);
      return persistQaError(taskId, msg);
    }

    updateTask(taskId, {
      qaStatus: "done",
      qaChangeSummary,
      qaTestPlan,
      qaTestCases,
    });
    const doneTask = findTaskById(taskId);
    if (doneTask) {
      broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(doneTask) });
    }

    log.info({ taskId }, "[QA] QA completed");
    return { ok: true };
  } catch (err) {
    const category = err instanceof RuntimeExecutionError ? err.category : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId, projectId, category }, "[QA] QA failed");
    return persistQaError(taskId, message);
  }
}
