import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects, runtimeProfiles, tasks } from "@aif/shared";

const { loggerMock, testDb } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  testDb: {
    current: undefined as unknown as ReturnType<typeof createTestDb>,
  },
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    logger: () => loggerMock,
  };
});

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { resolveEffectiveRuntimeProfile, resolveEffectiveRuntimeProfilesForTasks } = await import(
  "../index.js"
);

describe("runtime profile resolution", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  it("does not log a fallback when the project default is the first configured profile", () => {
    testDb.current
      .insert(projects)
      .values({
        id: "proj-1",
        name: "Project 1",
        rootPath: "/tmp/proj-1",
        defaultTaskRuntimeProfileId: "profile-project",
      })
      .run();
    testDb.current
      .insert(runtimeProfiles)
      .values({
        id: "profile-project",
        projectId: "proj-1",
        name: "Project Runtime",
        runtimeId: "codex",
        providerId: "openai",
        enabled: true,
      })
      .run();
    testDb.current
      .insert(tasks)
      .values({ id: "task-1", projectId: "proj-1", title: "Task 1" })
      .run();

    const result = resolveEffectiveRuntimeProfile({
      taskId: "task-1",
      projectId: "proj-1",
      mode: "task",
      systemDefaultRuntimeProfileId: null,
    });

    expect(result.source).toBe("project_default");
    expect(result.profile?.id).toBe("profile-project");
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it("batch resolves effective runtime profiles for task lists", () => {
    testDb.current
      .insert(projects)
      .values({
        id: "proj-1",
        name: "Project 1",
        rootPath: "/tmp/proj-1",
        defaultTaskRuntimeProfileId: "profile-project",
      })
      .run();
    testDb.current
      .insert(runtimeProfiles)
      .values([
        {
          id: "profile-project",
          projectId: "proj-1",
          name: "Project Runtime",
          runtimeId: "codex",
          providerId: "openai",
          enabled: true,
        },
        {
          id: "profile-task",
          projectId: "proj-1",
          name: "Task Runtime",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();
    testDb.current
      .insert(tasks)
      .values([
        { id: "task-project", projectId: "proj-1", title: "Project Default" },
        {
          id: "task-override",
          projectId: "proj-1",
          title: "Task Override",
          runtimeProfileId: "profile-task",
        },
      ])
      .run();

    const taskRows = testDb.current.select().from(tasks).all();
    const results = resolveEffectiveRuntimeProfilesForTasks(taskRows, {
      mode: "task",
      systemDefaultRuntimeProfileId: null,
    });

    expect(results.get("task-project")?.source).toBe("project_default");
    expect(results.get("task-project")?.profile?.id).toBe("profile-project");
    expect(results.get("task-override")?.source).toBe("task_override");
    expect(results.get("task-override")?.profile?.id).toBe("profile-task");
    expect(loggerMock.info).not.toHaveBeenCalled();
  });
});
