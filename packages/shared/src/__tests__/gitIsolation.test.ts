import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCurrentBranch,
  assertWorkingTreeClean,
  BranchIsolationError,
  branchExists,
  buildBranchName,
  describeDirtyWorkingTree,
  ensureFeatureBranch,
  getCurrentBranch,
  isBranchIsolationError,
  isGitRepo,
  projectUsesSharedBranchIsolation,
  slugifyTitle,
  workingTreeClean,
} from "../gitIsolation.js";
import { clearProjectConfigCache } from "../projectConfig.js";

const GIT_TEST_TIMEOUT_MS = 20_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeConfig(projectRoot: string, yaml: string): void {
  mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
  writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), yaml);
  clearProjectConfigCache(projectRoot);
  if (existsSync(join(projectRoot, ".git"))) {
    git(projectRoot, ["add", ".ai-factory/config.yaml"]);
    git(projectRoot, ["commit", "-m", "test: configure project"]);
  }
}

function initRepo(projectRoot: string): void {
  git(projectRoot, ["init"]);
  git(projectRoot, ["config", "user.email", "test@example.com"]);
  git(projectRoot, ["config", "user.name", "Test User"]);
  writeFileSync(join(projectRoot, "README.md"), "initial\n");
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-m", "init"]);
  git(projectRoot, ["branch", "-M", "main"]);
}

describe("gitIsolation", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "aif-git-isolation-"));
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("normalizes task titles into deterministic branch names", () => {
    expect(slugifyTitle(" Fix: Café checkout! ")).toBe("fix-cafe-checkout");
    expect(slugifyTitle("!!!")).toBe("task");
    expect(buildBranchName("feat", "Add payment retry", "12345678-abcd")).toBe(
      "feat/add-payment-retry-123456",
    );
    expect(buildBranchName("feature/", "Add payment retry", "abcdef12")).toBe(
      "feature/add-payment-retry-abcdef",
    );
  });

  it(
    "detects git repository and current branch state",
    () => {
      expect(isGitRepo(projectRoot)).toBe(false);

      initRepo(projectRoot);

      expect(isGitRepo(projectRoot)).toBe(true);
      expect(getCurrentBranch(projectRoot)).toBe("main");
      expect(branchExists(projectRoot, "main")).toBe(true);
      expect(workingTreeClean(projectRoot)).toBe(true);
      expect(describeDirtyWorkingTree(projectRoot)).toBeNull();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "creates a feature branch from the configured base branch",
    () => {
      initRepo(projectRoot);
      writeConfig(projectRoot, "git:\n  base_branch: main\n  branch_prefix: feature/\n");

      const result = ensureFeatureBranch({
        projectRoot,
        taskId: "12345678-0000-0000-0000-000000000000",
        title: "Add billing retry",
      });

      expect(result).toEqual({
        action: "created",
        branchName: "feature/add-billing-retry-123456",
      });
      expect(getCurrentBranch(projectRoot)).toBe("feature/add-billing-retry-123456");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "switches to an existing task branch and refuses to invent it in switchOnly mode",
    () => {
      initRepo(projectRoot);
      git(projectRoot, ["checkout", "-b", "feature/prepared-branch"]);
      git(projectRoot, ["checkout", "main"]);

      const switched = ensureFeatureBranch({
        projectRoot,
        taskId: "task-1",
        title: "Ignored",
        explicitBranchName: "feature/prepared-branch",
        switchOnly: true,
      });

      expect(switched).toEqual({ action: "switched", branchName: "feature/prepared-branch" });
      expect(getCurrentBranch(projectRoot)).toBe("feature/prepared-branch");

      git(projectRoot, ["checkout", "main"]);
      expect(() =>
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-2",
          title: "Missing branch",
          explicitBranchName: "feature/missing",
          switchOnly: true,
        }),
      ).toThrowError(BranchIsolationError);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "blocks branch changes when the worktree is dirty",
    () => {
      initRepo(projectRoot);
      writeFileSync(join(projectRoot, "dirty.txt"), "dirty\n");

      expect(workingTreeClean(projectRoot)).toBe(false);
      expect(describeDirtyWorkingTree(projectRoot)).toContain("dirty.txt");
      expect(() => assertWorkingTreeClean(projectRoot, "feature/x")).toThrowError(
        BranchIsolationError,
      );
      expect(() =>
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-3",
          title: "Needs branch",
          explicitBranchName: "feature/needs-branch",
        }),
      ).toThrowError(/uncommitted changes/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports branch drift as a structured isolation error",
    () => {
      initRepo(projectRoot);

      try {
        assertCurrentBranch(projectRoot, "feature/expected");
        throw new Error("expected branch drift");
      } catch (err) {
        expect(isBranchIsolationError(err)).toBe(true);
        expect((err as BranchIsolationError).kind).toBe("branch_drift");
        expect((err as BranchIsolationError).branchName).toBe("feature/expected");
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "skips branch preparation when git config disables it",
    () => {
      initRepo(projectRoot);
      writeConfig(projectRoot, "git:\n  enabled: false\n");

      expect(projectUsesSharedBranchIsolation(projectRoot)).toBe(false);
      expect(
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-4",
          title: "Disabled",
        }),
      ).toEqual({ action: "skipped", branchName: null, reason: "git.enabled=false" });

      writeConfig(projectRoot, "git:\n  create_branches: false\n");
      expect(
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-5",
          title: "No create",
        }),
      ).toEqual({
        action: "skipped",
        branchName: null,
        reason: "git.create_branches=false",
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "requires the configured base branch to exist before creating a branch",
    () => {
      initRepo(projectRoot);
      git(projectRoot, ["checkout", "-b", "topic"]);
      writeConfig(projectRoot, "git:\n  base_branch: develop\n");

      expect(() =>
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-6",
          title: "Base missing",
        }),
      ).toThrowError(/Base branch develop does not exist/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "returns switched when already on the task branch",
    () => {
      initRepo(projectRoot);
      git(projectRoot, ["checkout", "-b", "feature/already-there"]);

      expect(
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-7",
          title: "Already there",
          explicitBranchName: "feature/already-there",
          switchOnly: true,
        }),
      ).toEqual({ action: "switched", branchName: "feature/already-there" });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "by default warns and continues when git pull --ff-only fails (strict_base_update=false)",
    () => {
      initRepo(projectRoot);
      // No `origin` remote → `git pull` will fail. Default policy is
      // best-effort: branch creation should still succeed.
      git(projectRoot, ["checkout", "-b", "topic-dirty"]);

      expect(() =>
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-pull-warn",
          title: "Pull warn",
        }),
      ).not.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "throws base_update_failed when git pull fails and strict_base_update=true",
    () => {
      initRepo(projectRoot);
      writeConfig(
        projectRoot,
        "git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  strict_base_update: true\n",
      );
      git(projectRoot, ["checkout", "-b", "topic-strict"]);

      let captured: unknown;
      try {
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-pull-strict",
          title: "Pull strict",
        });
      } catch (err) {
        captured = err;
      }

      expect(isBranchIsolationError(captured)).toBe(true);
      const branchErr = captured as BranchIsolationError;
      expect(branchErr.kind).toBe("base_update_failed");
      expect(branchErr.message).toMatch(/git pull --ff-only/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "throws base_update_failed when HEAD is already on base and strict_base_update=true",
    () => {
      // Regression: previously the pull lived inside `if (current !== base)`,
      // so a HEAD that already happened to be on stale local base bypassed
      // strict_base_update entirely. Now the pull runs unconditionally.
      initRepo(projectRoot);
      writeConfig(
        projectRoot,
        "git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  strict_base_update: true\n",
      );
      // Stay on `main` — do NOT switch to a topic branch first.

      let captured: unknown;
      try {
        ensureFeatureBranch({
          projectRoot,
          taskId: "task-on-base-strict",
          title: "On base strict",
        });
      } catch (err) {
        captured = err;
      }

      expect(isBranchIsolationError(captured)).toBe(true);
      const branchErr = captured as BranchIsolationError;
      expect(branchErr.kind).toBe("base_update_failed");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
