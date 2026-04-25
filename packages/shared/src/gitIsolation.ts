import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";
import { getProjectConfig, type AifProjectGit } from "./projectConfig.js";

const log = logger("git-isolation");

export class BranchIsolationError extends Error {
  readonly kind:
    | "dirty_worktree"
    | "branch_missing"
    | "branch_drift"
    | "base_branch_unavailable"
    | "base_update_failed"
    | "checkout_failed"
    | "create_failed"
    | "invalid_branch_name"
    | "git_disabled_with_persisted_branch"
    | "not_a_repo_with_persisted_branch";
  readonly branchName: string | null;
  readonly projectRoot: string;

  constructor(
    kind: BranchIsolationError["kind"],
    message: string,
    projectRoot: string,
    branchName: string | null,
  ) {
    super(message);
    this.name = "BranchIsolationError";
    this.kind = kind;
    this.projectRoot = projectRoot;
    this.branchName = branchName;
  }
}

export function isBranchIsolationError(err: unknown): err is BranchIsolationError {
  return err instanceof BranchIsolationError;
}

export interface EnsureFeatureBranchInput {
  projectRoot: string;
  taskId: string;
  title: string;
  explicitBranchName?: string | null;
  switchOnly?: boolean;
}

export interface EnsureFeatureBranchResult {
  action: "skipped" | "created" | "switched";
  branchName: string | null;
  reason?: string;
}

const BRANCH_SLUG_MAX = 40;

export function slugifyTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, BRANCH_SLUG_MAX).replace(/-+$/, "");
  return trimmed || "task";
}

export function buildBranchName(prefix: string, title: string, taskId: string): string {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const slug = slugifyTitle(title);
  const shortId = taskId.replace(/-/g, "").slice(0, 6);
  return `${normalizedPrefix}${slug}-${shortId}`;
}

function runGit(
  cwd: string,
  args: string[],
  opts: { ignoreExit?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync("git", args, options);
    return { stdout: stdout.toString().trim(), stderr: "", status: 0 };
  } catch (err) {
    const error = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    const stdout = error.stdout ? error.stdout.toString().trim() : "";
    const stderr = error.stderr ? error.stderr.toString().trim() : String(err);
    const status = typeof error.status === "number" ? error.status : 1;
    if (!opts.ignoreExit) {
      log.debug({ cwd, args, status, stderr }, "git command failed");
    }
    return { stdout, stderr, status };
  }
}

export function isGitRepo(projectRoot: string): boolean {
  if (!existsSync(join(projectRoot, ".git"))) {
    const { status } = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"], {
      ignoreExit: true,
    });
    return status === 0;
  }
  return true;
}

export function getCurrentBranch(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout || stdout === "HEAD") return null;
  return stdout;
}

export function branchExists(projectRoot: string, branchName: string): boolean {
  const { status } = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { ignoreExit: true },
  );
  return status === 0;
}

export function workingTreeClean(projectRoot: string): boolean {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  return status === 0 && stdout.length === 0;
}

export function describeDirtyWorkingTree(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  if (status !== 0 || stdout.length === 0) return null;
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const summary = lines.slice(0, 5).join(", ");
  return lines.length > 5 ? `${summary}, +${lines.length - 5} more` : summary;
}

export function assertWorkingTreeClean(projectRoot: string, branchName: string | null): void {
  const dirty = describeDirtyWorkingTree(projectRoot);
  if (dirty) {
    throw new BranchIsolationError(
      "dirty_worktree",
      `Working tree at ${projectRoot} has uncommitted changes (${dirty}). Commit, stash, or discard them before continuing.`,
      projectRoot,
      branchName,
    );
  }
}

export function assertCurrentBranch(projectRoot: string, expected: string): void {
  const current = getCurrentBranch(projectRoot);
  if (current !== expected) {
    throw new BranchIsolationError(
      "branch_drift",
      `Branch drift detected: expected HEAD=${expected}, actual HEAD=${current ?? "detached"}.`,
      projectRoot,
      expected,
    );
  }
}

/**
 * Validate a string as a usable git branch name via `git check-ref-format
 * --branch`. Rejects empty prefixes ("" → "/slug"), double slashes,
 * Git-special refspecs like `@{-1}`, and everything else git won't let you
 * `checkout -b`. Normalising at this layer turns surprising `checkout_failed`
 * / `create_failed` errors mid-flow into a deterministic `invalid_branch_name`
 * blocker before any state changes.
 */
export function validateBranchName(projectRoot: string, branchName: string): void {
  if (!branchName || branchName.trim().length === 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name is empty or whitespace-only.`,
      projectRoot,
      branchName || null,
    );
  }
  if (branchName.startsWith("/") || branchName.endsWith("/") || branchName.includes("//")) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" has invalid slashes.`,
      projectRoot,
      branchName,
    );
  }
  const { status, stderr } = runGit(projectRoot, ["check-ref-format", "--branch", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" is not a valid git ref: ${stderr || "rejected by git check-ref-format"}.`,
      projectRoot,
      branchName,
    );
  }
}

function resolveGitConfig(projectRoot: string): AifProjectGit {
  return getProjectConfig(projectRoot).git;
}

export function projectUsesSharedBranchIsolation(projectRoot: string): boolean {
  const config = resolveGitConfig(projectRoot);
  return config.enabled && config.create_branches && isGitRepo(projectRoot);
}

export function ensureFeatureBranch(input: EnsureFeatureBranchInput): EnsureFeatureBranchResult {
  const { projectRoot, title, explicitBranchName, taskId, switchOnly } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    return { action: "skipped", branchName: null, reason: "git.enabled=false" };
  }
  if (!isGitRepo(projectRoot)) {
    return { action: "skipped", branchName: null, reason: "not a git work tree" };
  }
  if (!config.create_branches && !switchOnly) {
    return { action: "skipped", branchName: null, reason: "git.create_branches=false" };
  }

  const branchName = explicitBranchName?.trim()
    ? explicitBranchName.trim()
    : buildBranchName(config.branch_prefix, title, taskId);

  validateBranchName(projectRoot, branchName);

  const current = getCurrentBranch(projectRoot);
  if (current === branchName) {
    return { action: "switched", branchName };
  }

  assertWorkingTreeClean(projectRoot, branchName);

  if (branchExists(projectRoot, branchName)) {
    const { status, stderr } = runGit(projectRoot, ["checkout", branchName], {
      ignoreExit: true,
    });
    if (status !== 0) {
      throw new BranchIsolationError(
        "checkout_failed",
        `git checkout ${branchName} failed: ${stderr || "unknown error"}`,
        projectRoot,
        branchName,
      );
    }
    log.info(
      { projectRoot, branchName, previous: current, taskId },
      "Switched to existing feature branch",
    );
    return { action: "switched", branchName };
  }

  if (switchOnly) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${branchName} is missing from ${projectRoot}. Planner did not prepare it, or it was deleted between stages.`,
      projectRoot,
      branchName,
    );
  }

  // Step 1: ensure HEAD is on the base branch. We need it both as the
  // create-from-target for `git checkout -b` and as the target of the pull
  // policy below.
  if (current !== config.base_branch) {
    if (!branchExists(projectRoot, config.base_branch)) {
      throw new BranchIsolationError(
        "base_branch_unavailable",
        `Base branch ${config.base_branch} does not exist in ${projectRoot}. Cannot create ${branchName} from a known base.`,
        projectRoot,
        branchName,
      );
    }
    const { status: checkoutStatus, stderr: checkoutErr } = runGit(
      projectRoot,
      ["checkout", config.base_branch],
      { ignoreExit: true },
    );
    if (checkoutStatus !== 0) {
      throw new BranchIsolationError(
        "base_branch_unavailable",
        `Could not checkout base branch ${config.base_branch}: ${checkoutErr || "unknown error"}`,
        projectRoot,
        branchName,
      );
    }
  }

  // Step 2: refresh the base branch via `git pull --ff-only origin <base>`.
  // Run UNCONDITIONALLY (regardless of whether we just switched into base or
  // were already on it) so `git.strict_base_update=true` cannot be bypassed
  // by a HEAD that already happens to be on a stale local base.
  //
  // Policy: by default treat pull failure as best-effort (warn + continue
  // from local base). Projects that REQUIRE a fresh base before branching
  // opt into strict mode via `git.strict_base_update: true` — pull failure
  // becomes a hard BranchIsolationError("base_update_failed") classified as
  // blocked_external by the coordinator.
  const pullResult = runGit(projectRoot, ["pull", "--ff-only", "origin", config.base_branch], {
    ignoreExit: true,
  });
  if (pullResult.status !== 0) {
    if (config.strict_base_update) {
      throw new BranchIsolationError(
        "base_update_failed",
        `git pull --ff-only origin ${config.base_branch} failed: ${pullResult.stderr || "unknown error"}. ` +
          `Project has git.strict_base_update=true; refusing to branch from a stale base.`,
        projectRoot,
        branchName,
      );
    }
    log.warn(
      {
        projectRoot,
        branchName,
        baseBranch: config.base_branch,
        stderr: pullResult.stderr,
      },
      "Could not fast-forward base branch before creating feature branch; continuing from local base (git.strict_base_update=false)",
    );
  }

  const { status, stderr } = runGit(projectRoot, ["checkout", "-b", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "create_failed",
      `git checkout -b ${branchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      branchName,
    );
  }

  log.info({ projectRoot, branchName, previous: current, taskId }, "Created feature branch");
  return { action: "created", branchName };
}

/**
 * Restore HEAD to a branch a previous stage already persisted on the task.
 * Unlike `ensureFeatureBranch`, this treats `task.branchName` as a
 * source-of-truth contract: once planner stored it, every subsequent stage
 * MUST land on that branch or fail loud. Config flipping to `git.enabled=false`
 * or `git.create_branches=false` after a task was branched does not retroactively
 * release the stage to run on whatever HEAD happens to be.
 *
 * Failures throw `BranchIsolationError` with a kind the coordinator classifies
 * as `blocked_external`:
 *  - `git_disabled_with_persisted_branch` — config toggled off between stages
 *  - `not_a_repo_with_persisted_branch`  — repo was deleted / moved
 *  - `invalid_branch_name`               — persisted value is not a ref git accepts
 *  - `branch_missing`                    — branch was deleted between stages
 *  - `dirty_worktree`                    — switch would clobber uncommitted changes
 *  - `checkout_failed`                   — git refused the switch
 */
export interface RestorePersistedBranchInput {
  projectRoot: string;
  taskId: string;
  persistedBranchName: string;
}

export function restorePersistedBranch(input: RestorePersistedBranchInput): void {
  const { projectRoot, taskId, persistedBranchName } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    throw new BranchIsolationError(
      "git_disabled_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but git.enabled=false. Config drift between stages is not allowed — re-enable git or clear the branch binding before continuing.`,
      projectRoot,
      persistedBranchName,
    );
  }
  if (!isGitRepo(projectRoot)) {
    throw new BranchIsolationError(
      "not_a_repo_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but ${projectRoot} is not a git work tree.`,
      projectRoot,
      persistedBranchName,
    );
  }

  validateBranchName(projectRoot, persistedBranchName);

  const current = getCurrentBranch(projectRoot);
  if (current === persistedBranchName) {
    return;
  }

  if (!branchExists(projectRoot, persistedBranchName)) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${persistedBranchName} is missing from ${projectRoot}. It was deleted between stages.`,
      projectRoot,
      persistedBranchName,
    );
  }

  assertWorkingTreeClean(projectRoot, persistedBranchName);

  const { status, stderr } = runGit(projectRoot, ["checkout", persistedBranchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "checkout_failed",
      `git checkout ${persistedBranchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      persistedBranchName,
    );
  }

  log.info(
    { projectRoot, branchName: persistedBranchName, previous: current, taskId },
    "Restored persisted feature branch",
  );
}
