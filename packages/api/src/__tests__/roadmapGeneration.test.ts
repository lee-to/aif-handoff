import { describe, it, expect, beforeEach, vi } from "vitest";
import { generatePlanPath, projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const mockRunApiRuntimeOneShot = vi.fn();
vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
  resolveApiLightModel: async () => "claude-haiku-3-5",
}));

const {
  generateRoadmapFile,
  generateRoadmapTasks,
  importGeneratedTasks,
  buildTaskTags,
  RoadmapGenerationError,
} = await import("../services/roadmapGeneration.js");
const { findTasksByRoadmapAlias } = await import("@aif/data");

function createProjectWithRoadmap(roadmapContent: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "roadmap-test-"));
  const aiFactoryDir = join(tmpDir, ".ai-factory");
  mkdirSync(aiFactoryDir, { recursive: true });
  writeFileSync(join(aiFactoryDir, "ROADMAP.md"), roadmapContent);

  const db = testDb.current;
  const projectId = crypto.randomUUID();
  db.insert(projects)
    .values({
      id: projectId,
      name: "Test Project",
      rootPath: tmpDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  return { projectId, tmpDir };
}

function createProjectWithDescription(descriptionContent: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "roadmap-test-"));
  const aiFactoryDir = join(tmpDir, ".ai-factory");
  mkdirSync(aiFactoryDir, { recursive: true });
  writeFileSync(join(aiFactoryDir, "DESCRIPTION.md"), descriptionContent);

  const db = testDb.current;
  const projectId = crypto.randomUUID();
  db.insert(projects)
    .values({
      id: projectId,
      name: "Test Project",
      rootPath: tmpDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  return { projectId, tmpDir };
}

describe("roadmapGeneration", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    mockRunApiRuntimeOneShot.mockReset();
  });

  describe("buildTaskTags", () => {
    it("should generate required tag set", () => {
      const tags = buildTaskTags("v1.0", {
        title: "Setup auth",
        description: "",
        phase: 2,
        phaseName: "User Management",
        sequence: 3,
      });

      expect(tags).toContain("roadmap");
      expect(tags).toContain("rm:v1.0");
      expect(tags).toContain("phase:2");
      expect(tags).toContain("phase:user-management");
      expect(tags).toContain("seq:03");
    });

    it("should handle empty phaseName", () => {
      const tags = buildTaskTags("mvp", {
        title: "Init",
        description: "",
        phase: 1,
        phaseName: "",
        sequence: 1,
      });

      expect(tags).toContain("roadmap");
      expect(tags).toContain("rm:mvp");
      expect(tags).toContain("phase:1");
      expect(tags).toContain("seq:01");
      expect(tags).not.toContain("phase:");
    });
  });

  describe("generateRoadmapFile", () => {
    it("should throw NO_CONTEXT when no description and no vision", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "roadmap-test-"));
      mkdirSync(join(tmpDir, ".ai-factory"), { recursive: true });
      const db = testDb.current;
      const projectId = crypto.randomUUID();
      db.insert(projects)
        .values({
          id: projectId,
          name: "Empty",
          rootPath: tmpDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      await expect(generateRoadmapFile({ projectId })).rejects.toThrow(
        "Cannot generate roadmap without project context",
      );
    });

    it("should generate ROADMAP.md from DESCRIPTION.md", async () => {
      const { projectId } = createProjectWithDescription("# My App\nA todo app");

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText:
            "# Project Roadmap\n\n> A todo app\n\n## Milestones\n\n- [ ] **Setup** — init\n- [ ] **Auth** — login\n\n## Completed\n\n| Milestone | Date |\n|-----------|------|\n",
          usage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            costUsd: 0.002,
          },
        },
        context: {},
      });

      const result = await generateRoadmapFile({ projectId });
      expect(result.roadmapPath).toContain("ROADMAP.md");
      expect(result.content).toContain("# Project Roadmap");
      expect(result.content).toContain("Setup");

      const { existsSync, readFileSync } = await import("node:fs");
      expect(existsSync(result.roadmapPath)).toBe(true);
      expect(readFileSync(result.roadmapPath, "utf8")).toContain("# Project Roadmap");

      // Prompt must include roadmap generation instructions
      const callArgs = mockRunApiRuntimeOneShot.mock.calls[0][0];
      expect(callArgs.prompt).toContain("ROADMAP.md");
    });

    it("should accept vision without DESCRIPTION.md", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "roadmap-test-"));
      mkdirSync(join(tmpDir, ".ai-factory"), { recursive: true });
      const db = testDb.current;
      const projectId = crypto.randomUUID();
      db.insert(projects)
        .values({
          id: projectId,
          name: "Vision Only",
          rootPath: tmpDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText:
            "# Project Roadmap\n\n> Build an e-commerce platform\n\n## Milestones\n\n- [ ] **Products** — catalog\n",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        },
        context: {},
      });

      const result = await generateRoadmapFile({
        projectId,
        vision: "Build an e-commerce platform",
      });
      expect(result.content).toContain("e-commerce");
    });
  });

  describe("generateRoadmapTasks", () => {
    it("should throw ROADMAP_NOT_FOUND when file missing", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "roadmap-test-"));
      const db = testDb.current;
      const projectId = crypto.randomUUID();
      db.insert(projects)
        .values({
          id: projectId,
          name: "No Roadmap",
          rootPath: tmpDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      await expect(generateRoadmapTasks({ projectId, roadmapAlias: "test" })).rejects.toThrow(
        RoadmapGenerationError,
      );
    });

    it("should throw PROJECT_NOT_FOUND for invalid project", async () => {
      await expect(
        generateRoadmapTasks({ projectId: "nonexistent", roadmapAlias: "test" }),
      ).rejects.toThrow("not found");
    });

    it("should parse valid agent response", async () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap\n- [ ] Task A\n- [ ] Task B");

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText: JSON.stringify({
            alias: "v1",
            tasks: [
              { title: "Task A", description: "Do A", phase: 1, phaseName: "Setup", sequence: 1 },
              { title: "Task B", description: "Do B", phase: 1, phaseName: "Setup", sequence: 2 },
            ],
          }),
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
          },
        },
        context: {},
      });

      const result = await generateRoadmapTasks({ projectId, roadmapAlias: "v1" });
      expect(result.alias).toBe("v1");
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].title).toBe("Task A");
    });

    it("should handle agent returning markdown-fenced JSON", async () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap\n- [ ] X");

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText:
            '```json\n{"alias":"v1","tasks":[{"title":"X","description":"","phase":1,"phaseName":"P1","sequence":1}]}\n```',
          usage: {
            inputTokens: 50,
            outputTokens: 30,
            totalTokens: 80,
            costUsd: 0.0005,
          },
        },
        context: {},
      });

      const result = await generateRoadmapTasks({ projectId, roadmapAlias: "v1" });
      expect(result.tasks).toHaveLength(1);
    });

    it("should extract JSON from fence even when agent adds extra text after", async () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap\n- [ ] Y");

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText:
            '```json\n{"alias":"v1","tasks":[{"title":"Y","description":"do Y","phase":1,"phaseName":"P1","sequence":1}]}\n```\n\nThe ROADMAP.md file currently only contains a summary. Please provide detailed milestones.',
          usage: {
            inputTokens: 50,
            outputTokens: 30,
            totalTokens: 80,
            costUsd: 0.0005,
          },
        },
        context: {},
      });

      const result = await generateRoadmapTasks({ projectId, roadmapAlias: "v1" });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe("Y");
    });

    it("should throw PARSE_ERROR for invalid JSON", async () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap\n- [ ] X");

      mockRunApiRuntimeOneShot.mockResolvedValue({
        result: {
          outputText: "not json at all",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        },
        context: {},
      });

      await expect(generateRoadmapTasks({ projectId, roadmapAlias: "v1" })).rejects.toThrow(
        RoadmapGenerationError,
      );
    });
  });

  describe("importGeneratedTasks", () => {
    it("should create tasks with proper tags", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");

      const result = importGeneratedTasks(projectId, {
        alias: "sprint-1",
        tasks: [
          {
            title: "Build API",
            description: "REST endpoints",
            phase: 1,
            phaseName: "Backend",
            sequence: 1,
          },
          {
            title: "Add auth",
            description: "JWT auth",
            phase: 1,
            phaseName: "Backend",
            sequence: 2,
          },
        ],
      });

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.taskIds).toHaveLength(2);
      expect(result.roadmapAlias).toBe("sprint-1");

      const stored = findTasksByRoadmapAlias(projectId, "sprint-1");
      expect(stored).toHaveLength(2);
    });

    it("should skip duplicates by normalized title", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");
      const generation = {
        alias: "v1",
        tasks: [{ title: "Setup DB", description: "", phase: 1, phaseName: "Init", sequence: 1 }],
      };

      // First import
      const first = importGeneratedTasks(projectId, generation);
      expect(first.created).toBe(1);

      // Second import — same title should be skipped
      const second = importGeneratedTasks(projectId, generation);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it("should track per-phase statistics", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");

      const result = importGeneratedTasks(projectId, {
        alias: "v1",
        tasks: [
          { title: "T1", description: "", phase: 1, phaseName: "A", sequence: 1 },
          { title: "T2", description: "", phase: 2, phaseName: "B", sequence: 1 },
          { title: "T3", description: "", phase: 2, phaseName: "B", sequence: 2 },
        ],
      });

      expect(result.byPhase[1]).toEqual({ created: 1, skipped: 0 });
      expect(result.byPhase[2]).toEqual({ created: 2, skipped: 0 });
    });

    // Regression: lee-to/aif-handoff#55 — roadmap import used to assign every
    // task the shared default plan path `.ai-factory/PLAN.md` because
    // importGeneratedTasks didn't compute a per-task planPath, so successive
    // tasks would overwrite each other's plan file on disk. The fix derives a
    // unique slug-based planPath per task while leaving plannerMode untouched.
    it("should assign a unique per-task planPath on roadmap import (#55)", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");

      const tasks = [
        {
          title: "Implement auth flow",
          description: "JWT + refresh",
          phase: 1,
          phaseName: "Backend",
          sequence: 1,
        },
        {
          title: "Add product search",
          description: "Postgres FTS",
          phase: 1,
          phaseName: "Backend",
          sequence: 2,
        },
        {
          title: "Build dashboard page",
          description: "React + Tailwind",
          phase: 2,
          phaseName: "Frontend",
          sequence: 1,
        },
      ];

      const result = importGeneratedTasks(projectId, {
        alias: "v1",
        tasks,
      });

      expect(result.created, "all three tasks should be created").toBe(3);
      expect(result.skipped).toBe(0);

      const stored = findTasksByRoadmapAlias(projectId, "v1");
      expect(stored).toHaveLength(3);

      const planPaths = stored.map((t) => t.planPath);
      const uniquePlanPaths = new Set(planPaths);
      expect(uniquePlanPaths.size, "each imported task must have a distinct planPath").toBe(3);

      for (const path of planPaths) {
        expect(
          path,
          "no imported task should inherit the shared default `.ai-factory/PLAN.md`",
        ).not.toBe(".ai-factory/PLAN.md");
        expect(path.startsWith(".ai-factory/plans/")).toBe(true);
        expect(path.endsWith(".md")).toBe(true);
      }

      // Each planPath must match the slug computed from the title via the
      // shared helper — keeps the contract with `generatePlanPath` explicit.
      for (const task of tasks) {
        const expectedPath = generatePlanPath(task.title, "full", {
          plansDir: ".ai-factory/plans/",
          defaultPlanPath: ".ai-factory/PLAN.md",
        });
        const matched = stored.find((t) => t.title === task.title);
        expect(matched, `task ${task.title} should exist`).toBeDefined();
        expect(matched?.planPath).toBe(expectedPath);
      }
    });

    // Regression: slug collisions between distinct titles must not produce
    // duplicate planPaths. When two titles slugify to the same string (e.g.
    // punctuation-only differences), the second task should get a `-2`
    // suffix before `.md`, and so on.
    it("should resolve slug collisions with numeric suffixes", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");

      const tasks = [
        {
          title: "Fix bug!",
          description: "first",
          phase: 1,
          phaseName: "Backend",
          sequence: 1,
        },
        {
          title: "Fix bug?",
          description: "second",
          phase: 1,
          phaseName: "Backend",
          sequence: 2,
        },
        {
          title: "Fix bug.",
          description: "third",
          phase: 1,
          phaseName: "Backend",
          sequence: 3,
        },
      ];

      const result = importGeneratedTasks(projectId, { alias: "v1", tasks });
      expect(result.created).toBe(3);

      const stored = findTasksByRoadmapAlias(projectId, "v1");
      const planPaths = stored.map((t) => t.planPath).sort();

      expect(new Set(planPaths).size, "collisions must be resolved to unique paths").toBe(3);
      expect(planPaths).toEqual(
        [
          ".ai-factory/plans/fix-bug.md",
          ".ai-factory/plans/fix-bug-2.md",
          ".ai-factory/plans/fix-bug-3.md",
        ].sort(),
      );
    });

    // A second import against the same project should keep stepping the
    // suffix forward instead of overwriting any existing plan file.
    it("should avoid collisions across repeated imports", () => {
      const { projectId } = createProjectWithRoadmap("# Roadmap");

      importGeneratedTasks(projectId, {
        alias: "v1",
        tasks: [
          {
            title: "Fix bug",
            description: "first pass",
            phase: 1,
            phaseName: "Backend",
            sequence: 1,
          },
        ],
      });

      importGeneratedTasks(projectId, {
        alias: "v2",
        tasks: [
          {
            title: "Fix bug",
            description: "second pass",
            phase: 1,
            phaseName: "Backend",
            sequence: 1,
          },
        ],
      });

      const all = [
        ...findTasksByRoadmapAlias(projectId, "v1"),
        ...findTasksByRoadmapAlias(projectId, "v2"),
      ];
      const planPaths = all.map((t) => t.planPath).sort();
      expect(planPaths).toEqual(
        [".ai-factory/plans/fix-bug.md", ".ai-factory/plans/fix-bug-2.md"].sort(),
      );
    });
  });
});
