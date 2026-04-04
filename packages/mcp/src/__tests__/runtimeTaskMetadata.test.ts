import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { createRuntimeProfile, createTask, updateProjectRuntimeDefaults } =
  await import("@aif/data");
const { assertRuntimeProfileSelection, buildEffectiveTaskRuntimeMetadata } =
  await import("../tools/runtimeTaskMetadata.js");

function seedProject(id = "proj-1") {
  testDb.current
    .insert(projects)
    .values({ id, name: `Project ${id}`, rootPath: "/tmp/test" })
    .run();
}

describe("runtimeTaskMetadata", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject("proj-1");
  });

  it("accepts runtime profiles from same project and global scope", () => {
    const sameProjectProfile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Project Runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    const globalProfile = createRuntimeProfile({
      projectId: null,
      name: "Global Runtime",
      runtimeId: "codex",
      providerId: "openai",
      enabled: true,
    });
    const log = { warn: vi.fn() };

    expect(() =>
      assertRuntimeProfileSelection({
        toolName: "handoff_create_task",
        projectId: "proj-1",
        runtimeProfileId: sameProjectProfile!.id,
        log,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeProfileSelection({
        toolName: "handoff_create_task",
        projectId: "proj-1",
        runtimeProfileId: globalProfile!.id,
        log,
      }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rejects cross-project runtime profile selections", () => {
    seedProject("proj-2");
    const profile = createRuntimeProfile({
      projectId: "proj-2",
      name: "Other Project Runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    const log = { warn: vi.fn() };

    expect(() =>
      assertRuntimeProfileSelection({
        toolName: "handoff_update_task",
        projectId: "proj-1",
        runtimeProfileId: profile!.id,
        log,
      }),
    ).toThrow(/does not belong to project/);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects disabled runtime profiles", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Disabled Runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: false,
    });
    const log = { warn: vi.fn() };

    expect(() =>
      assertRuntimeProfileSelection({
        toolName: "handoff_update_task",
        projectId: "proj-1",
        runtimeProfileId: profile!.id,
        log,
      }),
    ).toThrow(/disabled/);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("builds effective runtime metadata for task-level override", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Task Runtime",
      runtimeId: "codex",
      providerId: "openai",
      enabled: true,
    });
    const task = createTask({
      projectId: "proj-1",
      title: "Runtime Override",
      description: "Test",
      runtimeProfileId: profile!.id,
    });

    const metadata = buildEffectiveTaskRuntimeMetadata(task!.id, "proj-1");

    expect(metadata).toEqual({
      source: "task_override",
      profileId: profile!.id,
      runtimeId: "codex",
      providerId: "openai",
      profileName: "Task Runtime",
    });
  });

  it("falls back to project default metadata when task override is absent", () => {
    const projectDefault = createRuntimeProfile({
      projectId: "proj-1",
      name: "Project Default Runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    updateProjectRuntimeDefaults("proj-1", {
      defaultTaskRuntimeProfileId: projectDefault!.id,
    });
    const task = createTask({
      projectId: "proj-1",
      title: "Project Default Runtime",
      description: "Test",
    });

    const metadata = buildEffectiveTaskRuntimeMetadata(task!.id, "proj-1");

    expect(metadata).toEqual({
      source: "project_default",
      profileId: projectDefault!.id,
      runtimeId: "claude",
      providerId: "anthropic",
      profileName: "Project Default Runtime",
    });
  });
});
