import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureFeatureBranch,
  buildBranchName,
  slugifyTitle,
  getCurrentBranch,
  branchExists,
  isGitRepo,
} from "../gitBranch.js";

function initRepo(root: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.local"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
    cwd: root,
    stdio: "ignore",
  });
}

function writeConfig(root: string, yaml: string): void {
  const dir = join(root, ".ai-factory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), yaml);
}

/** Stage + commit any pending changes so the work tree is clean before
 *  exercising `ensureFeatureBranch` (which now hard-gates on dirty). */
function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message, "--no-verify"], { cwd: root, stdio: "ignore" });
}

describe("gitBranch helpers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitbranch-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("slugifyTitle lowercases, hyphenates, trims length", () => {
    expect(slugifyTitle("Hello World!")).toBe("hello-world");
    expect(slugifyTitle("   Spaces  only ")).toBe("spaces-only");
    expect(slugifyTitle("")).toBe("task");
    const long = slugifyTitle("x".repeat(80));
    expect(long.length).toBeLessThanOrEqual(40);
  });

  it("buildBranchName composes prefix + slug + task id fragment", () => {
    const name = buildBranchName("feature/", "Add Login Flow", "abcdef12-3456-7890");
    expect(name).toMatch(/^feature\/add-login-flow-[a-f0-9]+$/);
    expect(name.startsWith("feature/")).toBe(true);
  });

  it("buildBranchName adds trailing slash when missing", () => {
    const name = buildBranchName("fix", "Bug", "11111111");
    expect(name.startsWith("fix/")).toBe(true);
  });

  it("isGitRepo returns true in real git repo, false otherwise", () => {
    expect(isGitRepo(root)).toBe(false);
    initRepo(root);
    expect(isGitRepo(root)).toBe(true);
  });

  it("ensureFeatureBranch skips when not a git repo", () => {
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "t1",
      title: "Sample",
    });
    expect(result.action).toBe("skipped");
    expect(result.branchName).toBeNull();
  });

  it("ensureFeatureBranch skips when git.create_branches=false", () => {
    initRepo(root);
    writeConfig(
      root,
      "git:\n  enabled: true\n  base_branch: main\n  create_branches: false\n  branch_prefix: feature/\n",
    );
    commitAll(root, "config");
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "t1",
      title: "Sample",
    });
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("create_branches");
    expect(getCurrentBranch(root)).toBe("main");
  });

  it("ensureFeatureBranch creates a feature branch with defaults", () => {
    initRepo(root);
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "abcdef12-aaaa",
      title: "Add login flow",
    });
    expect(result.action).toBe("created");
    expect(result.branchName).toMatch(/^feature\/add-login-flow-/);
    expect(getCurrentBranch(root)).toBe(result.branchName);
    expect(branchExists(root, result.branchName!)).toBe(true);
  });

  it("ensureFeatureBranch uses explicitBranchName when provided", () => {
    initRepo(root);
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "t1",
      title: "Something else",
      explicitBranchName: "feature/custom-branch",
    });
    expect(result.action).toBe("created");
    expect(result.branchName).toBe("feature/custom-branch");
    expect(getCurrentBranch(root)).toBe("feature/custom-branch");
  });

  it("ensureFeatureBranch switches to existing branch instead of recreating", () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/custom-branch"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });

    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "t1",
      title: "Anything",
      explicitBranchName: "feature/custom-branch",
    });
    expect(result.action).toBe("switched");
    expect(getCurrentBranch(root)).toBe("feature/custom-branch");
  });

  it("ensureFeatureBranch is idempotent when already on the target branch", () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/my-task"], {
      cwd: root,
      stdio: "ignore",
    });
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "t1",
      title: "x",
      explicitBranchName: "feature/my-task",
    });
    expect(result.action).toBe("switched");
    expect(getCurrentBranch(root)).toBe("feature/my-task");
  });

  it("honors branch_prefix from project config", () => {
    initRepo(root);
    writeConfig(
      root,
      "git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  branch_prefix: fix/\n",
    );
    commitAll(root, "config");
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "11111111",
      title: "Bug report",
    });
    expect(result.branchName?.startsWith("fix/")).toBe(true);
  });

  it("ensureFeatureBranch throws BranchIsolationError(dirty_worktree) when tree is dirty", async () => {
    initRepo(root);
    // Introduce an uncommitted change
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    const { ensureFeatureBranch: fn, BranchIsolationError } = await import("../gitBranch.js");
    expect(() => fn({ projectRoot: root, taskId: "t1", title: "X" })).toThrow(BranchIsolationError);
    try {
      fn({ projectRoot: root, taskId: "t1", title: "X" });
    } catch (err) {
      const { isBranchIsolationError } = await import("../gitBranch.js");
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("dirty_worktree");
      }
    }
  });

  it("ensureFeatureBranch(switchOnly) throws branch_missing instead of creating", async () => {
    initRepo(root);
    const {
      ensureFeatureBranch: fn,
      BranchIsolationError,
      isBranchIsolationError,
    } = await import("../gitBranch.js");
    try {
      fn({
        projectRoot: root,
        taskId: "t1",
        title: "anything",
        explicitBranchName: "feature/does-not-exist",
        switchOnly: true,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BranchIsolationError);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("branch_missing");
      }
    }
    // HEAD must still be on main — no silent create
    expect(getCurrentBranch(root)).toBe("main");
  });

  it("ensureFeatureBranch(switchOnly) works when branch already exists", async () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/has"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    const { ensureFeatureBranch: fn } = await import("../gitBranch.js");
    const result = fn({
      projectRoot: root,
      taskId: "t1",
      title: "x",
      explicitBranchName: "feature/has",
      switchOnly: true,
    });
    expect(result.action).toBe("switched");
    expect(getCurrentBranch(root)).toBe("feature/has");
  });

  it("assertCurrentBranch throws branch_drift when HEAD moved", async () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/a"], { cwd: root, stdio: "ignore" });
    const { assertCurrentBranch, isBranchIsolationError } = await import("../gitBranch.js");
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    try {
      assertCurrentBranch(root, "feature/a");
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("branch_drift");
      }
    }
  });

  it("ensureFeatureBranch throws base_branch_unavailable when base is missing", async () => {
    initRepo(root);
    // rename main away so base can't be found
    execFileSync("git", ["branch", "-m", "main", "trunk"], { cwd: root, stdio: "ignore" });
    const { ensureFeatureBranch: fn, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      fn({ projectRoot: root, taskId: "t1", title: "x" });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("base_branch_unavailable");
      }
    }
  });

  it("validateBranchName rejects empty string", async () => {
    initRepo(root);
    const { validateBranchName, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      validateBranchName(root, "");
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("invalid_branch_name");
      }
    }
  });

  it("validateBranchName rejects leading and trailing slashes and double slashes", async () => {
    initRepo(root);
    const { validateBranchName, isBranchIsolationError } = await import("../gitBranch.js");
    for (const bad of ["/foo", "foo/", "feature//bar"]) {
      try {
        validateBranchName(root, bad);
        throw new Error(`expected throw for ${bad}`);
      } catch (err) {
        expect(isBranchIsolationError(err)).toBe(true);
        if (isBranchIsolationError(err)) {
          expect(err.kind).toBe("invalid_branch_name");
        }
      }
    }
  });

  it("validateBranchName rejects Git-special refspec like @{-1}", async () => {
    initRepo(root);
    const { validateBranchName, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      validateBranchName(root, "@{-1}");
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("invalid_branch_name");
      }
    }
  });

  it("validateBranchName accepts conventional feature branch names", async () => {
    initRepo(root);
    const { validateBranchName } = await import("../gitBranch.js");
    expect(() => validateBranchName(root, "feature/add-login-123")).not.toThrow();
    expect(() => validateBranchName(root, "fix/urgent-bug")).not.toThrow();
  });

  it("ensureFeatureBranch throws invalid_branch_name when prefix is empty", async () => {
    initRepo(root);
    // Write a config with branch_prefix=""
    const dir = join(root, ".ai-factory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.yaml"),
      'git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  branch_prefix: ""\n',
    );
    commitAll(root, "config");
    const { ensureFeatureBranch: fn, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      fn({ projectRoot: root, taskId: "t1", title: "Sample" });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("invalid_branch_name");
      }
    }
  });

  it("restorePersistedBranch throws git_disabled_with_persisted_branch when config drifts off", async () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/persisted"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    writeConfig(
      root,
      "git:\n  enabled: false\n  base_branch: main\n  create_branches: true\n  branch_prefix: feature/\n",
    );
    commitAll(root, "disable git");
    const { restorePersistedBranch, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      restorePersistedBranch({
        projectRoot: root,
        taskId: "t1",
        persistedBranchName: "feature/persisted",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("git_disabled_with_persisted_branch");
      }
    }
  });

  it("restorePersistedBranch throws branch_missing when branch was deleted", async () => {
    initRepo(root);
    const { restorePersistedBranch, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      restorePersistedBranch({
        projectRoot: root,
        taskId: "t1",
        persistedBranchName: "feature/never",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("branch_missing");
      }
    }
  });

  it("restorePersistedBranch switches and is idempotent", async () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/ok"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    const { restorePersistedBranch, getCurrentBranch: curr } = await import("../gitBranch.js");
    restorePersistedBranch({ projectRoot: root, taskId: "t1", persistedBranchName: "feature/ok" });
    expect(curr(root)).toBe("feature/ok");
    // Idempotent
    restorePersistedBranch({ projectRoot: root, taskId: "t1", persistedBranchName: "feature/ok" });
    expect(curr(root)).toBe("feature/ok");
  });

  it("restorePersistedBranch throws dirty_worktree before switching", async () => {
    initRepo(root);
    execFileSync("git", ["checkout", "-b", "feature/ok"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    const { restorePersistedBranch, isBranchIsolationError } = await import("../gitBranch.js");
    try {
      restorePersistedBranch({
        projectRoot: root,
        taskId: "t1",
        persistedBranchName: "feature/ok",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("dirty_worktree");
      }
    }
  });
});
