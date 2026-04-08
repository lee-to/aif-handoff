import { describe, it, expect, beforeEach, vi } from "vitest";
import { projects } from "@aif/shared";
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

      // Prompt must include /aif-roadmap skill prefix
      const callArgs = mockRunApiRuntimeOneShot.mock.calls[0][0];
      expect(callArgs.prompt).toMatch(/^\/aif-roadmap generate\n/);
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
  });
});
