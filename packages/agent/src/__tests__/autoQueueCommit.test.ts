import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { UsageSource } from "@aif/runtime";
import { createGitTestRoot } from "./gitTestUtils.js";

const testDb = { current: createTestDb() };
const executeSubagentQueryMock = vi.fn();

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../subagentQuery.js", () => ({
  executeSubagentQuery: (...args: unknown[]) => executeSubagentQueryMock(...args),
}));

const { ensureAutoQueueTaskCommit } = await import("../autoQueueCommit.js");
const { findTaskById } = await import("@aif/data");

function createGitProject(): { rootPath: string; initialSha: string } {
  return createGitTestRoot("auto-queue-commit-");
}

function seedAutoQueueTask(rootPath: string, initialSha: string): void {
  testDb.current
    .insert(projects)
    .values({
      id: "project",
      name: "Project",
      rootPath,
      autoQueueMode: true,
    })
    .run();
  testDb.current
    .insert(tasks)
    .values({
      id: "task",
      projectId: "project",
      title: "Task",
      status: "review",
      autoQueueCommitStatus: "pending",
      autoQueueCommitBaseSha: initialSha,
    })
    .run();
}

describe("ensureAutoQueueTaskCommit", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    executeSubagentQueryMock.mockReset();
  });

  it("creates and verifies one commit for a dirty auto-queue task", async () => {
    const { rootPath, initialSha } = createGitProject();
    seedAutoQueueTask(rootPath, initialSha);
    writeFileSync(join(rootPath, "task.txt"), "done\n");
    executeSubagentQueryMock.mockImplementationOnce(async (input: { projectRoot: string }) => {
      execFileSync("git", ["add", "-A"], { cwd: input.projectRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feat: complete task"], {
        cwd: input.projectRoot,
        stdio: "ignore",
      });
      return { resultText: "created" };
    });

    const result = await ensureAutoQueueTaskCommit({ taskId: "task", projectRoot: rootPath });
    const stored = findTaskById("task");

    expect(result.status).toBe("committed");
    expect(stored?.autoQueueCommitStatus).toBe("committed");
    expect(stored?.commitSha).toBe(result.commitSha);
    expect(stored?.commitSha).not.toBe(initialSha);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: rootPath,
        encoding: "utf8",
      }),
    ).toBe("");
    expect(executeSubagentQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKind: "commit",
        fallbackSlashCommand: "/aif-commit",
        sessionReusePolicy: "never",
        usageSource: UsageSource.COMMIT,
      }),
    );
  });

  it("records no_changes without creating an empty commit", async () => {
    const { rootPath, initialSha } = createGitProject();
    seedAutoQueueTask(rootPath, initialSha);

    const result = await ensureAutoQueueTaskCommit({ taskId: "task", projectRoot: rootPath });
    const stored = findTaskById("task");
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();

    expect(result).toEqual({ status: "no_changes", commitSha: null });
    expect(stored?.autoQueueCommitStatus).toBe("no_changes");
    expect(stored?.commitSha).toBeNull();
    expect(currentSha).toBe(initialSha);
    expect(executeSubagentQueryMock).not.toHaveBeenCalled();
  });

  it("does not consume the commit gate for a human-owned task", async () => {
    const { rootPath, initialSha } = createGitProject();
    seedAutoQueueTask(rootPath, initialSha);
    testDb.current.update(tasks).set({ executionOwner: "human" }).run();
    writeFileSync(join(rootPath, "task.txt"), "human work\n");

    const result = await ensureAutoQueueTaskCommit({ taskId: "task", projectRoot: rootPath });

    expect(result).toEqual({ status: "not_required", commitSha: null });
    expect(executeSubagentQueryMock).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime reports success without creating a commit", async () => {
    const { rootPath, initialSha } = createGitProject();
    seedAutoQueueTask(rootPath, initialSha);
    writeFileSync(join(rootPath, "task.txt"), "dirty\n");
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "looks good" });

    await expect(
      ensureAutoQueueTaskCommit({ taskId: "task", projectRoot: rootPath }),
    ).rejects.toThrow(/left uncommitted changes/i);

    expect(findTaskById("task")?.autoQueueCommitStatus).toBe("failed");
  });

  it("reconciles a clean commit created before restart without running the workflow twice", async () => {
    const { rootPath, initialSha } = createGitProject();
    seedAutoQueueTask(rootPath, initialSha);
    writeFileSync(join(rootPath, "task.txt"), "done before crash\n");
    execFileSync("git", ["add", "-A"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: complete before crash"], {
      cwd: rootPath,
      stdio: "ignore",
    });

    const result = await ensureAutoQueueTaskCommit({ taskId: "task", projectRoot: rootPath });

    expect(result.status).toBe("committed");
    expect(result.commitSha).not.toBe(initialSha);
    expect(findTaskById("task")?.commitSha).toBe(result.commitSha);
    expect(executeSubagentQueryMock).not.toHaveBeenCalled();
  });
});
