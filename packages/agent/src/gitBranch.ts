import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfig, logger, type AifProjectGit } from "@aif/shared";

const log = logger("git-branch");

export interface EnsureFeatureBranchInput {
  projectRoot: string;
  /** Task title used to derive a slug when `explicitBranchName` is not provided. */
  title: string;
  /** If set (e.g. persisted on the task), skip slug derivation and use this name. */
  explicitBranchName?: string | null;
  /** If true (default), `git pull` base branch before creating. Disabled in tests. */
  pullBaseBranch?: boolean;
  /** If true, resolve to an existing branch only — do not create. Used by implementer. */
  switchOnly?: boolean;
}

export interface EnsureFeatureBranchResult {
  /** `"skipped"` when git is disabled, repo missing, or create_branches=false. */
  action: "skipped" | "created" | "switched";
  /** Resolved branch name. `null` when action === "skipped". */
  branchName: string | null;
  /** Short human-readable reason when skipped. */
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

function resolveGitConfig(projectRoot: string): AifProjectGit {
  return getProjectConfig(projectRoot).git;
}

/**
 * Create or switch to the task's feature branch.
 *
 * - Returns `action: "skipped"` when `git.enabled=false`, the project isn't a
 *   git repo, or `git.create_branches=false` — the caller treats this as a
 *   no-op, not an error.
 * - In `switchOnly` mode, only switches to an existing branch. If the branch
 *   doesn't exist, falls through to creation (implementer recovers when
 *   planner skipped branching, e.g. on an older task).
 */
export function ensureFeatureBranch(
  input: EnsureFeatureBranchInput & { taskId: string },
): EnsureFeatureBranchResult {
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

  const current = getCurrentBranch(projectRoot);
  if (current === branchName) {
    return { action: "switched", branchName };
  }

  if (branchExists(projectRoot, branchName)) {
    const { status, stderr } = runGit(projectRoot, ["checkout", branchName], {
      ignoreExit: true,
    });
    if (status !== 0) {
      throw new Error(`git checkout ${branchName} failed: ${stderr}`);
    }
    log.info({ projectRoot, branchName, previous: current }, "Switched to existing feature branch");
    return { action: "switched", branchName };
  }

  if (switchOnly) {
    if (!config.create_branches) {
      return {
        action: "skipped",
        branchName: null,
        reason: `branch ${branchName} missing and create_branches=false`,
      };
    }
  }

  const pullBase = input.pullBaseBranch ?? true;
  if (pullBase && current !== config.base_branch && branchExists(projectRoot, config.base_branch)) {
    const { status: checkoutStatus, stderr: checkoutErr } = runGit(
      projectRoot,
      ["checkout", config.base_branch],
      { ignoreExit: true },
    );
    if (checkoutStatus !== 0) {
      log.warn(
        { projectRoot, baseBranch: config.base_branch, stderr: checkoutErr },
        "Could not checkout base branch before creating feature branch — creating from current HEAD instead",
      );
    } else {
      runGit(projectRoot, ["pull", "--ff-only", "origin", config.base_branch], {
        ignoreExit: true,
      });
    }
  }

  const { status, stderr } = runGit(projectRoot, ["checkout", "-b", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new Error(`git checkout -b ${branchName} failed: ${stderr}`);
  }

  log.info({ projectRoot, branchName, previous: current }, "Created feature branch");
  return { action: "created", branchName };
}
