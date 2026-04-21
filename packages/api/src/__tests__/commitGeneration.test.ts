import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunApiRuntimeOneShot = vi.fn();
const mockFindProjectById = vi.fn();
const mockGetProjectConfig = vi.fn();

vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
}));

vi.mock("@aif/data", () => ({
  findProjectById: (id: string) => mockFindProjectById(id),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getProjectConfig: (...args: unknown[]) => mockGetProjectConfig(...args),
  };
});

const { runCommitQuery, buildCommitPrompt } = await import("../services/commitGeneration.js");

function gitConfig(skipPush: boolean) {
  return {
    git: {
      enabled: true,
      base_branch: "main",
      create_branches: true,
      branch_prefix: "feature/",
      skip_push_after_commit: skipPush,
    },
  };
}

describe("buildCommitPrompt", () => {
  it("includes git add -A and push instruction when shouldPush=true", () => {
    const prompt = buildCommitPrompt(true);
    expect(prompt).toContain("git add -A");
    expect(prompt).toContain("git push");
    expect(prompt).not.toMatch(/Do NOT push/i);
  });

  it("includes git add -A and explicit no-push when shouldPush=false", () => {
    const prompt = buildCommitPrompt(false);
    expect(prompt).toContain("git add -A");
    expect(prompt).toMatch(/Do NOT push/i);
    expect(prompt).toContain("skip_push_after_commit");
  });

  it("forbids --no-verify, amend, and Co-Authored-By", () => {
    const prompt = buildCommitPrompt(true);
    expect(prompt).toContain("--no-verify");
    expect(prompt).toContain("amend");
    expect(prompt).toContain("Co-Authored-By");
  });
});

describe("runCommitQuery", () => {
  beforeEach(() => {
    mockRunApiRuntimeOneShot.mockReset();
    mockFindProjectById.mockReset();
    mockGetProjectConfig.mockReset();
    mockFindProjectById.mockReturnValue({ id: "p1", rootPath: "/tmp/p1" });
  });

  it("returns ok:false when project not found", async () => {
    mockFindProjectById.mockReturnValue(undefined);
    const res = await runCommitQuery({ projectId: "missing" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Project not found/);
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("sends push-enabled prompt when skip_push_after_commit=false", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });
    expect(res.ok).toBe(true);
    expect(mockRunApiRuntimeOneShot).toHaveBeenCalledTimes(1);
    const callArg = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(callArg.workflowKind).toBe("commit");
    expect(callArg.fallbackSlashCommand).toBe("/aif-commit");
    expect(callArg.prompt).toContain("git add -A");
    expect(callArg.prompt).toContain("git push");
    expect(callArg.prompt).not.toMatch(/Do NOT push/i);
  });

  it("sends no-push prompt when skip_push_after_commit=true", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(true));
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
    const res = await runCommitQuery({ projectId: "p1" });
    expect(res.ok).toBe(true);
    const callArg = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(callArg.prompt).toMatch(/Do NOT push/i);
    expect(callArg.prompt).not.toMatch(/\brun `git push`/);
  });

  it("returns ok:false with error message when runtime throws", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockRunApiRuntimeOneShot.mockRejectedValue(new Error("boom"));
    const res = await runCommitQuery({ projectId: "p1" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });
});
