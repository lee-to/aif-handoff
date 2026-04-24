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
    const result = ensureFeatureBranch({
      projectRoot: root,
      taskId: "11111111",
      title: "Bug report",
    });
    expect(result.branchName?.startsWith("fix/")).toBe(true);
  });
});
