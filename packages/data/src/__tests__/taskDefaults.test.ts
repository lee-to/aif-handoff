import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { clearProjectConfigCache } from "@aif/shared";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const { createTask } = await import("../index.js");

const PROJECT_ID = "proj-task-defaults";
let projectRoot: string;

beforeEach(() => {
  testDb.current = createTestDb();
  projectRoot = mkdtempSync(join(tmpdir(), "task-defaults-test-"));
  mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
  clearProjectConfigCache();
  testDb.current
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Task Defaults Test", rootPath: projectRoot })
    .run();
});

afterEach(() => {
  clearProjectConfigCache();
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeTaskDefaults(yaml: string): void {
  writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), yaml);
}

describe("createTask task_defaults fallback", () => {
  it("applies project task_defaults when flags are omitted", () => {
    writeTaskDefaults(
      "task_defaults:\n  autoMode: false\n  plannerMode: full\n  skipReview: true\n  useSubagents: false\n  planTests: true\n  maxReviewIterations: 2\n",
    );
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T1",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.autoMode).toBe(false);
    expect(task!.plannerMode).toBe("full");
    expect(task!.skipReview).toBe(true);
    expect(task!.useSubagents).toBe(false);
    expect(task!.planTests).toBe(true);
    expect(task!.maxReviewIterations).toBe(2);
  });

  it("explicit task arg overrides task_defaults", () => {
    writeTaskDefaults("task_defaults:\n  skipReview: true\n  plannerMode: full\n");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T2",
      description: "d",
      skipReview: false,
    });
    expect(task).toBeDefined();
    expect(task!.skipReview).toBe(false); // explicit wins
    expect(task!.plannerMode).toBe("full"); // from task_defaults
  });

  it("falls back to schema default when neither explicit nor task_defaults", () => {
    // no config.yaml → task_defaults empty → schema defaults
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T3",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.autoMode).toBe(true); // schema default
    expect(task!.plannerMode).toBe("fast"); // schema default
    expect(task!.skipReview).toBe(false); // schema default
    expect(task!.maxReviewIterations).toBe(3); // schema default
  });

  it("partial task_defaults leaves unspecified flags on schema default", () => {
    writeTaskDefaults("task_defaults:\n  useSubagents: true\n");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T4",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.useSubagents).toBe(true); // from task_defaults
    expect(task!.autoMode).toBe(true); // schema default (not in task_defaults)
    expect(task!.skipReview).toBe(false); // schema default
  });
});
