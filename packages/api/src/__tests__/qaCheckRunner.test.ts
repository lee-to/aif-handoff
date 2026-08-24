import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockRunApiRuntimeOneShot = vi.fn();
const mockResolveApiRuntimeContext = vi.fn();
const mockFindTaskById = vi.fn();
const mockUpdateTask = vi.fn();
const mockGetProjectConfig = vi.fn();
const mockGetMcpStatus = vi.fn();

vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
  resolveApiRuntimeContext: (...args: unknown[]) => mockResolveApiRuntimeContext(...args),
}));

vi.mock("@aif/data", () => ({
  findTaskById: (...args: unknown[]) => mockFindTaskById(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
}));

vi.mock("../ws.js", () => ({ broadcast: vi.fn() }));
vi.mock("../repositories/tasks.js", () => ({
  toTaskBroadcastPayload: (task: { id: string }) => ({ id: task.id }),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getProjectConfig: (...args: unknown[]) => mockGetProjectConfig(...args),
  };
});

const { buildQaCheckPrompt, checkPlaywrightMcp, runQaCheckQuery } =
  await import("../services/qaCheckRunner.js");
const { computeQaBranchSlug } = await import("../services/qaRunner.js");

const BRANCH = "feature/foo";

describe("qaCheckRunner", () => {
  let root: string;
  let artifactDir: string;
  let reportPath: string;

  beforeEach(() => {
    root = join(tmpdir(), `qa-check-runner-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    artifactDir = join(root, ".ai-factory/qa", computeQaBranchSlug(BRANCH, root));
    reportPath = join(artifactDir, "qa-check.md");
    mockRunApiRuntimeOneShot.mockReset();
    mockResolveApiRuntimeContext.mockReset();
    mockFindTaskById.mockReset();
    mockUpdateTask.mockReset();
    mockGetProjectConfig.mockReset();
    mockGetMcpStatus.mockReset();
    mockGetProjectConfig.mockReturnValue({ paths: { qa: ".ai-factory/qa/" } });
    mockFindTaskById.mockReturnValue({
      id: "t1",
      executionOwner: "ai",
      branchName: BRANCH,
      qaTestCases: "# Test Cases\n\n## TC-001",
    });
    mockGetMcpStatus.mockResolvedValue({ installed: true, serverName: "playwright" });
    mockResolveApiRuntimeContext.mockResolvedValue({
      adapter: { getMcpStatus: mockGetMcpStatus },
      resolvedProfile: { runtimeId: "codex", transport: "app-server" },
    });
    mockRunApiRuntimeOneShot.mockImplementation(async () => {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(reportPath, "# QA Check\n\nTC-001: Pass", "utf-8");
      return { result: { outputText: "done" }, context: {} };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("builds a non-interactive command prompt that keeps non-browser cases running", () => {
    const prompt = buildQaCheckPrompt({
      testCasesPath: "/tmp/test-cases.md",
      reportPath: "/tmp/qa-check.md",
      playwrightMcp: { configured: false, runtimeId: "codex", transport: "app-server" },
    });

    expect(prompt.startsWith("/aif-qa-check agent\n")).toBe(true);
    expect(prompt).toContain("Do not infer a built-in browser from the Codex app-server");
    expect(prompt).toContain("Continue every CLI, backend-test, API, file/docs");
    expect(prompt).toContain("Playwright MCP configuration preflight: not configured");
  });

  it("checks configured Playwright MCP without inferring browser from app-server", async () => {
    mockGetMcpStatus.mockResolvedValue({ installed: false, serverName: "playwright" });

    await expect(
      checkPlaywrightMcp({ projectId: "p1", taskId: "t1", executionRoot: root }),
    ).resolves.toEqual({ configured: false, runtimeId: "codex", transport: "app-server" });
    expect(mockGetMcpStatus).toHaveBeenCalledWith({ serverName: "playwright" });
  });

  it("executes qa-check with the long timeout and persists the report", async () => {
    const result = await runQaCheckQuery({ projectId: "p1", taskId: "t1", executionRoot: root });

    expect(result).toEqual({ ok: true });
    const runtimeInput = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(runtimeInput.workflowKind).toBe("qa-check");
    expect(runtimeInput.fallbackSlashCommand).toBe("/aif-qa-check agent");
    expect(runtimeInput.runTimeoutMs).toBeGreaterThan(0);
    expect(runtimeInput.prompt).toContain(join(artifactDir, "test-cases.md"));
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      qaCheckStatus: "done",
      qaCheckReport: "# QA Check\n\nTC-001: Pass",
      qaCheckPlaywrightConfigured: true,
    });
  });

  it("fails cleanly when qa-check.md is not produced", async () => {
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "done" }, context: {} });

    const result = await runQaCheckQuery({ projectId: "p1", taskId: "t1", executionRoot: root });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("qa-check.md");
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { qaCheckStatus: "error" });
  });

  it("rejects tasks without generated test cases before runtime execution", async () => {
    mockFindTaskById.mockReturnValue({
      id: "t1",
      executionOwner: "ai",
      branchName: BRANCH,
      qaTestCases: null,
    });

    const result = await runQaCheckQuery({ projectId: "p1", taskId: "t1", executionRoot: root });

    expect(result).toMatchObject({ ok: false, code: "qa_test_cases_required" });
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { qaCheckStatus: "error" });
  });
});
