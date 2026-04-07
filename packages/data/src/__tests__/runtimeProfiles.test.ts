import { describe, it, expect, beforeEach, vi } from "vitest";
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

const {
  createProject,
  findProjectById,
  createTask,
  findTaskById,
  createChatSession,
  findChatSessionById,
  createRuntimeProfile,
  findRuntimeProfileById,
  updateRuntimeProfile,
  deleteRuntimeProfile,
  listRuntimeProfiles,
  toRuntimeProfileResponse,
  updateProjectRuntimeDefaults,
  updateTaskRuntimeOverride,
  updateChatSessionRuntime,
  resolveEffectiveRuntimeProfile,
} = await import("../index.js");

function seedProject(id = "proj-1") {
  testDb.current
    .insert(projects)
    .values({ id, name: "Test", rootPath: "/tmp/test" })
    .run();
}

describe("runtime profiles data layer", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
  });

  it("creates and maps runtime profiles", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Claude Default",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      headers: { "x-org": "aif" },
      options: { timeoutMs: 1000 },
      enabled: true,
    });

    expect(profile).toBeDefined();
    const mapped = toRuntimeProfileResponse(profile!);
    expect(mapped.projectId).toBe("proj-1");
    expect(mapped.runtimeId).toBe("claude");
    expect(mapped.headers).toEqual({ "x-org": "aif" });
    expect(mapped.options).toEqual({ timeoutMs: 1000 });
  });

  it("updates runtime profiles", () => {
    const profile = createRuntimeProfile({
      name: "Codex",
      runtimeId: "codex",
      providerId: "openai",
      enabled: true,
    });

    const updated = updateRuntimeProfile(profile!.id, {
      defaultModel: "gpt-5.4",
      enabled: false,
      options: { mode: "cli" },
    });

    expect(updated).toBeDefined();
    expect(updated!.defaultModel).toBe("gpt-5.4");
    expect(updated!.enabled).toBe(false);
    expect(toRuntimeProfileResponse(updated!).options).toEqual({ mode: "cli" });
  });

  it("lists runtime profiles with global fallback", () => {
    createRuntimeProfile({
      projectId: "proj-1",
      name: "Project Profile",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    createRuntimeProfile({
      projectId: null,
      name: "Global Profile",
      runtimeId: "codex",
      providerId: "openai",
    });

    const scoped = listRuntimeProfiles({ projectId: "proj-1" });
    const withGlobal = listRuntimeProfiles({ projectId: "proj-1", includeGlobal: true });

    expect(scoped).toHaveLength(1);
    expect(withGlobal).toHaveLength(2);
  });

  it("updates runtime defaults and overrides for project/task/chat", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Default",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    const project = updateProjectRuntimeDefaults("proj-1", {
      defaultTaskRuntimeProfileId: profile!.id,
      defaultChatRuntimeProfileId: profile!.id,
    });
    expect(project?.defaultTaskRuntimeProfileId).toBe(profile!.id);
    expect(project?.defaultChatRuntimeProfileId).toBe(profile!.id);

    const task = createTask({ projectId: "proj-1", title: "T", description: "D" });
    updateTaskRuntimeOverride(task!.id, {
      runtimeProfileId: profile!.id,
      modelOverride: "claude-sonnet",
      runtimeOptions: { approval: "never" },
    });
    const taskAfter = findTaskById(task!.id);
    expect(taskAfter?.runtimeProfileId).toBe(profile!.id);
    expect(taskAfter?.modelOverride).toBe("claude-sonnet");
    expect(taskAfter?.runtimeOptionsJson).toBe(JSON.stringify({ approval: "never" }));

    const chat = createChatSession({ projectId: "proj-1" });
    updateChatSessionRuntime(chat!.id, {
      runtimeProfileId: profile!.id,
      runtimeSessionId: "runtime-session-1",
    });
    const chatAfter = findChatSessionById(chat!.id);
    expect(chatAfter?.runtimeProfileId).toBe(profile!.id);
    expect(chatAfter?.runtimeSessionId).toBe("runtime-session-1");
  });

  it("resolves task override first", () => {
    const projectDefault = createRuntimeProfile({
      projectId: "proj-1",
      name: "Project Default",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    const override = createRuntimeProfile({
      projectId: "proj-1",
      name: "Task Override",
      runtimeId: "codex",
      providerId: "openai",
    });

    createProject({
      name: "Other",
      rootPath: "/tmp/other",
      defaultTaskRuntimeProfileId: projectDefault!.id,
    });

    const task = createTask({
      projectId: "proj-1",
      title: "Resolve",
      description: "Test",
      runtimeProfileId: override!.id,
    });

    const resolved = resolveEffectiveRuntimeProfile({ taskId: task!.id });
    expect(resolved.source).toBe("task_override");
    expect(resolved.profile?.id).toBe(override!.id);
  });

  it("falls back to project default when task override is unavailable", () => {
    const unavailableOverride = createRuntimeProfile({
      projectId: "proj-1",
      name: "Disabled Override",
      runtimeId: "codex",
      providerId: "openai",
      enabled: false,
    });
    const projectDefault = createRuntimeProfile({
      projectId: "proj-1",
      name: "Project Default",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });

    updateProjectRuntimeDefaults("proj-1", {
      defaultTaskRuntimeProfileId: projectDefault!.id,
    });

    const task = createTask({
      projectId: "proj-1",
      title: "Fallback",
      description: "Test",
      runtimeProfileId: unavailableOverride!.id,
    });

    const resolved = resolveEffectiveRuntimeProfile({
      taskId: task!.id,
      systemDefaultRuntimeProfileId: null,
    });
    expect(resolved.source).toBe("project_default");
    expect(resolved.profile?.id).toBe(projectDefault!.id);
  });

  it("falls back to system default when task/project defaults are missing", () => {
    const systemDefault = createRuntimeProfile({
      projectId: null,
      name: "System Default",
      runtimeId: "codex",
      providerId: "openai",
      enabled: true,
    });

    const task = createTask({
      projectId: "proj-1",
      title: "System fallback",
      description: "Test",
    });

    const resolved = resolveEffectiveRuntimeProfile({
      taskId: task!.id,
      systemDefaultRuntimeProfileId: systemDefault!.id,
    });
    expect(resolved.source).toBe("system_default");
    expect(resolved.profile?.id).toBe(systemDefault!.id);
  });

  it("returns none when no profile is available", () => {
    const task = createTask({
      projectId: "proj-1",
      title: "No runtime",
      description: "Test",
    });

    const resolved = resolveEffectiveRuntimeProfile({
      taskId: task!.id,
      systemDefaultRuntimeProfileId: null,
    });
    expect(resolved.source).toBe("none");
    expect(resolved.profile).toBeNull();
  });

  it("deletes runtime profiles", () => {
    const created = createRuntimeProfile({
      name: "Delete me",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    expect(findRuntimeProfileById(created!.id)).toBeDefined();
    deleteRuntimeProfile(created!.id);
    expect(findRuntimeProfileById(created!.id)).toBeUndefined();
  });

  it("persists runtime defaults when creating a project", () => {
    const profile = createRuntimeProfile({
      name: "Default",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    const project = createProject({
      name: "With defaults",
      rootPath: "/tmp/with-defaults",
      defaultTaskRuntimeProfileId: profile!.id,
      defaultChatRuntimeProfileId: profile!.id,
    });

    const found = findProjectById(project!.id);
    expect(found?.defaultTaskRuntimeProfileId).toBe(profile!.id);
    expect(found?.defaultChatRuntimeProfileId).toBe(profile!.id);
  });
});
