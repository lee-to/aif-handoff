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

  it("falls back to the global default when neither explicit nor task_defaults", () => {
    // no config.yaml → task_defaults empty → global defaults
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T3",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.autoMode).toBe(true);
    expect(task!.plannerMode).toBe("fast");
    expect(task!.useSubagents).toBe(false); // AGENT_USE_SUBAGENTS
    expect(task!.maxReviewIterations).toBe(3); // AGENT_MAX_REVIEW_ITERATIONS
    // Mode-driven defaults are the last layer, so fast mode skips review and
    // plans no tests — the same values POST /tasks used to fill in itself.
    expect(task!.skipReview).toBe(true);
    expect(task!.planTests).toBe(false);
    expect(task!.planDocs).toBe(false);
  });

  it("partial task_defaults leaves unspecified flags on the global default", () => {
    writeTaskDefaults("task_defaults:\n  useSubagents: true\n");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T4",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.useSubagents).toBe(true); // from task_defaults
    expect(task!.autoMode).toBe(true); // global default (not in task_defaults)
    expect(task!.skipReview).toBe(true); // fast-mode default
  });

  it("task_defaults outrank the mode-driven flag defaults", () => {
    // fast mode would give skipReview=true / planTests=false; the project
    // overrides both, and that must survive all the way into the row.
    writeTaskDefaults(
      "task_defaults:\n  plannerMode: fast\n  skipReview: false\n  planTests: true\n",
    );
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T5",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.plannerMode).toBe("fast");
    expect(task!.skipReview).toBe(false);
    expect(task!.planTests).toBe(true);
    // planDocs has no task_defaults entry, so it stays on the mode default.
    expect(task!.planDocs).toBe(false);
  });

  it("derives mode-driven defaults from the task_defaults plannerMode", () => {
    // plannerMode comes from the project, so the full-mode flag defaults must
    // follow it rather than the "fast" the caller never asked for.
    writeTaskDefaults("task_defaults:\n  plannerMode: full\n");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T6",
      description: "d",
    });
    expect(task).toBeDefined();
    expect(task!.plannerMode).toBe("full");
    expect(task!.skipReview).toBe(false);
    expect(task!.planTests).toBe(true);
    expect(task!.planDocs).toBe(true);
  });

  it("lets subagent mode from task_defaults disable the improve/verify passes", () => {
    writeTaskDefaults("task_defaults:\n  useSubagents: true\n");
    const task = createTask({
      projectId: PROJECT_ID,
      title: "T7",
      description: "d",
      runPlanImprove: true,
      runPostVerify: true,
    });
    expect(task).toBeDefined();
    expect(task!.useSubagents).toBe(true);
    expect(task!.runPlanImprove).toBe(false);
    expect(task!.runPostVerify).toBe(false);
  });
});
