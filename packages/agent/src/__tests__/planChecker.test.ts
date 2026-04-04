import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
const queryMock = vi.fn();
(globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
  queryMock;

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const {
  runPlanChecker,
  normalizeMarkdownFence,
  hasChecklistItems,
  countConvertibleBullets,
  convertBulletsToCheckboxes,
  isPlanAlreadyChecklist,
} = await import("../subagents/planChecker.js");

function streamSuccess(result: string): AsyncIterable<{
  type: "result";
  subtype: "success";
  result: string;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result };
    },
  };
}

describe("normalizeMarkdownFence", () => {
  it("extracts content from markdown fenced block", () => {
    expect(normalizeMarkdownFence("```markdown\n## Plan\n- [ ] A\n```")).toBe("## Plan\n- [ ] A");
  });

  it("returns trimmed text when no fence present", () => {
    expect(normalizeMarkdownFence("  ## Plan\n- [ ] A  ")).toBe("## Plan\n- [ ] A");
  });
});

describe("hasChecklistItems", () => {
  it("detects unchecked items", () => {
    expect(hasChecklistItems("- [ ] Do thing")).toBe(true);
  });

  it("detects checked items", () => {
    expect(hasChecklistItems("- [x] Done")).toBe(true);
  });

  it("rejects plain bullets", () => {
    expect(hasChecklistItems("- plain bullet")).toBe(false);
  });
});

describe("countConvertibleBullets", () => {
  it("counts plain bullets that could become checkboxes", () => {
    const plan = "- [ ] Already checkbox\n- Plain bullet item\n- Another plain item\n- ab";
    expect(countConvertibleBullets(plan)).toBe(2); // "ab" is too short (<=3)
  });

  it("returns 0 when all bullets are checkboxes", () => {
    const plan = "- [ ] A thing\n- [x] Done thing";
    expect(countConvertibleBullets(plan)).toBe(0);
  });
});

describe("convertBulletsToCheckboxes", () => {
  it("converts plain bullets to unchecked checkboxes", () => {
    expect(convertBulletsToCheckboxes("- Do thing")).toBe("- [ ] Do thing");
    expect(convertBulletsToCheckboxes("* Another")).toBe("* [ ] Another");
  });

  it("preserves existing checkboxes", () => {
    expect(convertBulletsToCheckboxes("- [ ] Already")).toBe("- [ ] Already");
    expect(convertBulletsToCheckboxes("- [x] Done")).toBe("- [x] Done");
  });

  it("preserves indentation", () => {
    expect(convertBulletsToCheckboxes("  - Indented")).toBe("  - [ ] Indented");
  });
});

describe("isPlanAlreadyChecklist", () => {
  it("returns true when all items are checkboxes", () => {
    expect(isPlanAlreadyChecklist("## Plan\n- [ ] A\n- [x] B")).toBe(true);
  });

  it("returns false when plain bullets exist", () => {
    expect(isPlanAlreadyChecklist("- [ ] A\n- Plain bullet")).toBe(false);
  });

  it("returns false when no checklist items at all", () => {
    expect(isPlanAlreadyChecklist("## Just a heading")).toBe(false);
  });
});

describe("runPlanChecker", () => {
  beforeEach(() => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    testDb.current = createTestDb();
    queryMock.mockReset();

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: "/tmp/plan-checker-test",
      })
      .run();
  });

  it("skips LLM call when plan already has proper checklist format", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-skip",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "## Plan\n- [ ] Step 1\n- [x] Step 2",
      })
      .run();

    await runPlanChecker("task-skip", "/tmp/plan-checker-test");

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("converts plain bullets locally and skips LLM when mixed plan", async () => {
    testDb.current
      .insert(tasks)
      .values({
        id: "task-local",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "## Plan\n- [ ] Checkbox item\n- Plain bullet item",
      })
      .run();

    await runPlanChecker("task-local", "/tmp/plan-checker-test");

    expect(queryMock).not.toHaveBeenCalled();
    const row = testDb.current.select().from(tasks).where(eq(tasks.id, "task-local")).get();
    expect(row?.plan).toContain("- [ ] Plain bullet item");
  });

  it("uses local fallback when LLM returns non-plan content", async () => {
    queryMock.mockReturnValue(streamSuccess("I cannot help with that request."));

    testDb.current
      .insert(tasks)
      .values({
        id: "task-fallback",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "- Implement feature A\n- Write tests for A",
      })
      .run();

    await runPlanChecker("task-fallback", "/tmp/plan-checker-test");

    const row = testDb.current.select().from(tasks).where(eq(tasks.id, "task-fallback")).get();
    expect(row?.plan).toContain("- [ ] Implement feature A");
  });

  it("runs without explicit agent override", async () => {
    queryMock.mockReturnValue(streamSuccess("## Plan\n- [ ] Keep this"));

    testDb.current
      .insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "## Plan\n- Existing item that needs conversion and is long enough",
      })
      .run();

    await runPlanChecker("task-1", "/tmp/plan-checker-test");

    const call = queryMock.mock.calls[0]?.[0] as {
      options?: { extraArgs?: { agent?: string } };
    };
    expect(call.options?.extraArgs).toBeUndefined();
  });

  it("keeps existing plan when checker returns non-checklist junk and local fallback also fails", async () => {
    queryMock.mockReturnValue(
      streamSuccess(`/
├── index.html
└── .ai-factory/
    └── PLAN.md`),
    );

    // Plan has no bullets at all — pure prose — so local fallback can't help
    testDb.current
      .insert(tasks)
      .values({
        id: "task-2",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "Implement the feature by editing main.ts and adding the handler.\nThen write tests.",
      })
      .run();

    await runPlanChecker("task-2", "/tmp/plan-checker-test");

    const row = testDb.current.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(row?.plan).toBe(
      "Implement the feature by editing main.ts and adding the handler.\nThen write tests.",
    );
  });

  it("accepts fenced markdown and persists valid checklist plan", async () => {
    queryMock.mockReturnValue(
      streamSuccess(
        "```markdown\n## Good Plan\n- [ ] Implement step 1 logic\n- [x] Mark the done section as complete\n```",
      ),
    );

    // Plan with prose-only content so it can't be short-circuited
    testDb.current
      .insert(tasks)
      .values({
        id: "task-3",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "plan_ready",
        plan: "## Good Plan\nImplement step 1 logic.\nMark the done section as complete.",
      })
      .run();

    await runPlanChecker("task-3", "/tmp/plan-checker-test");

    const row = testDb.current.select().from(tasks).where(eq(tasks.id, "task-3")).get();
    expect(row?.plan).toBe(
      "## Good Plan\n- [ ] Implement step 1 logic\n- [x] Mark the done section as complete",
    );
  });

  it("writes plan file to custom planPath instead of default PLAN.md", async () => {
    const projectRoot = join("/tmp", `plan-checker-planpath-${Date.now()}`);
    mkdirSync(projectRoot, { recursive: true });

    queryMock.mockReturnValue(
      streamSuccess("## Custom\n- [ ] Implement step 1 logic\n- [x] Mark done section complete"),
    );

    testDb.current
      .insert(projects)
      .values({
        id: "project-planpath",
        name: "PlanPath Test",
        rootPath: projectRoot,
      })
      .run();

    testDb.current
      .insert(tasks)
      .values({
        id: "task-planpath",
        projectId: "project-planpath",
        title: "Task with planPath",
        description: "Desc",
        status: "plan_ready",
        plan: "## Custom\nImplement step 1 logic.\nMark done section complete.",
        planPath: "docs/MY_PLAN.md",
      })
      .run();

    await runPlanChecker("task-planpath", projectRoot);

    const customPlanFile = join(projectRoot, "docs/MY_PLAN.md");
    const defaultPlanFile = join(projectRoot, ".ai-factory/PLAN.md");

    expect(existsSync(customPlanFile)).toBe(true);
    expect(existsSync(defaultPlanFile)).toBe(false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("writes plan to FIX_PLAN.md when task.isFix is true", async () => {
    const projectRoot = join("/tmp", `plan-checker-fix-${Date.now()}`);
    mkdirSync(projectRoot, { recursive: true });

    queryMock.mockReturnValue(
      streamSuccess("## Fix\n- [ ] Patch the bug in handler\n- [x] Verify it is done"),
    );

    testDb.current
      .insert(projects)
      .values({
        id: "project-fix",
        name: "Fix Test",
        rootPath: projectRoot,
      })
      .run();

    testDb.current
      .insert(tasks)
      .values({
        id: "task-fix",
        projectId: "project-fix",
        title: "Fix task",
        description: "Desc",
        status: "plan_ready",
        plan: "## Fix\nPatch the bug in handler.\nVerify it is done.",
        isFix: true,
      })
      .run();

    await runPlanChecker("task-fix", projectRoot);

    const fixPlanFile = join(projectRoot, ".ai-factory/FIX_PLAN.md");
    const defaultPlanFile = join(projectRoot, ".ai-factory/PLAN.md");

    expect(existsSync(fixPlanFile)).toBe(true);
    expect(existsSync(defaultPlanFile)).toBe(false);

    rmSync(projectRoot, { recursive: true, force: true });
  });
});
