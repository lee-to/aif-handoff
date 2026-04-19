import { describe, it, expect, beforeEach, vi } from "vitest";
import { projects, usageEvents } from "@aif/shared";
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
  persistRuntimeProfileLimitSnapshot,
  clearRuntimeProfileLimitSnapshot,
  deleteRuntimeProfile,
  listRuntimeProfiles,
  getRuntimeProfileResponseById,
  toRuntimeProfileResponse,
  updateProjectRuntimeDefaults,
  updateTaskRuntimeOverride,
  persistTaskRuntimeLimitSnapshot,
  clearTaskRuntimeLimitSnapshot,
  blockTaskForRuntimeGateIfEligible,
  updateChatSessionRuntime,
  resolveEffectiveRuntimeProfile,
  toTaskResponse,
  evaluateRuntimeLimitGate,
} = await import("../index.js");

function seedProject(id = "proj-1") {
  testDb.current
    .insert(projects)
    .values({ id, name: "Test", rootPath: "/tmp/test" })
    .run();
}

function makeLimitSnapshot() {
  return {
    source: "sdk_event" as const,
    status: "warning" as const,
    precision: "heuristic" as const,
    checkedAt: "2026-04-17T10:00:00.000Z",
    providerId: "anthropic",
    runtimeId: "claude",
    profileId: "profile-1",
    primaryScope: "time" as const,
    resetAt: "2026-04-17T15:00:00.000Z",
    retryAfterSeconds: null,
    warningThreshold: null,
    windows: [
      {
        scope: "time" as const,
        percentUsed: 92,
        percentRemaining: 8,
        resetAt: "2026-04-17T15:00:00.000Z",
      },
    ],
    providerMeta: {
      rateLimitType: "five_hour",
    },
  };
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

  it("attaches the latest recorded usage for each runtime profile", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Codex SDK",
      runtimeId: "codex",
      providerId: "openai",
      transport: "sdk",
      enabled: true,
    });

    testDb.current
      .insert(usageEvents)
      .values([
        {
          id: "usage-old",
          source: "chat",
          projectId: "proj-1",
          profileId: profile!.id,
          runtimeId: "codex",
          providerId: "openai",
          transport: "sdk",
          usageReporting: "full",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costUsd: 0.01,
          createdAt: "2026-04-18T09:00:00.000Z",
        },
        {
          id: "usage-new",
          source: "chat",
          projectId: "proj-1",
          profileId: profile!.id,
          runtimeId: "codex",
          providerId: "openai",
          transport: "sdk",
          usageReporting: "full",
          inputTokens: 40,
          outputTokens: 12,
          totalTokens: 52,
          costUsd: 0.03,
          createdAt: "2026-04-18T10:00:00.000Z",
        },
      ])
      .run();

    const resolved = getRuntimeProfileResponseById(profile!.id);

    expect(resolved?.lastUsage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
      costUsd: 0.03,
    });
    expect(resolved?.lastUsageAt).toBe("2026-04-18T10:00:00.000Z");
  });

  it("persists and clears runtime profile limit snapshots", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Claude Default",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    const snapshot = {
      ...makeLimitSnapshot(),
      profileId: profile!.id,
    };

    const persisted = persistRuntimeProfileLimitSnapshot(
      profile!.id,
      snapshot,
      "2026-04-17T10:00:05.000Z",
    );
    const mapped = toRuntimeProfileResponse(persisted!);
    expect(mapped.runtimeLimitSnapshot).toEqual(snapshot);
    expect(mapped.runtimeLimitUpdatedAt).toBe("2026-04-17T10:00:05.000Z");
    expect(persisted!.updatedAt).toBe(profile!.updatedAt);

    const cleared = clearRuntimeProfileLimitSnapshot(profile!.id, "2026-04-17T11:00:00.000Z");
    const clearedMapped = toRuntimeProfileResponse(cleared!);
    expect(clearedMapped.runtimeLimitSnapshot).toBeNull();
    expect(clearedMapped.runtimeLimitUpdatedAt).toBe("2026-04-17T11:00:00.000Z");
    expect(cleared!.updatedAt).toBe(profile!.updatedAt);
  });

  it("does not proactively gate provider-blocked snapshots without reset hints", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Claude Default",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    persistRuntimeProfileLimitSnapshot(
      profile!.id,
      {
        ...makeLimitSnapshot(),
        status: "blocked",
        profileId: profile!.id,
        resetAt: null,
        windows: [{ scope: "time", percentUsed: 100, percentRemaining: 0, resetAt: null }],
      },
      "2026-04-17T10:00:05.000Z",
    );

    const decision = evaluateRuntimeLimitGate(toRuntimeProfileResponse(findRuntimeProfileById(profile!.id)!), 0);
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("proactively gates provider-blocked snapshots with retryAfterSeconds even without resetAt", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "RetryAfter profile",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    persistRuntimeProfileLimitSnapshot(
      profile!.id,
      {
        ...makeLimitSnapshot(),
        status: "blocked",
        profileId: profile!.id,
        resetAt: null,
        retryAfterSeconds: 120,
        windows: [{ scope: "time", percentUsed: 100, percentRemaining: 0, resetAt: null }],
      },
      "2026-04-17T10:00:05.000Z",
    );

    const decision = evaluateRuntimeLimitGate(
      toRuntimeProfileResponse(findRuntimeProfileById(profile!.id)!),
      0,
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("provider_blocked");
    expect(decision.futureHint.source).toBe("snapshot_retry_after");
  });

  it("proactively gates provider-blocked snapshots with window reset fallback", () => {
    const nowMs = Date.parse("2026-04-17T10:00:00.000Z");
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Window reset profile",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    persistRuntimeProfileLimitSnapshot(
      profile!.id,
      {
        ...makeLimitSnapshot(),
        status: "blocked",
        profileId: profile!.id,
        resetAt: null,
        retryAfterSeconds: null,
        windows: [
          {
            scope: "time",
            percentUsed: 100,
            percentRemaining: 0,
            resetAt: "2026-04-17T10:30:00.000Z",
          },
        ],
      },
      "2026-04-17T10:00:05.000Z",
    );

    const decision = evaluateRuntimeLimitGate(
      toRuntimeProfileResponse(findRuntimeProfileById(profile!.id)!),
      nowMs,
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("provider_blocked");
    expect(decision.futureHint.source).toBe("window_reset_at");
  });

  it("does not proactively gate exact-threshold warnings without reset hints", () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "OpenAI Default",
      runtimeId: "codex",
      providerId: "openai",
    });
    persistRuntimeProfileLimitSnapshot(
      profile!.id,
      {
        ...makeLimitSnapshot(),
        status: "warning",
        precision: "exact",
        profileId: profile!.id,
        resetAt: null,
        warningThreshold: 10,
        windows: [
          {
            scope: "requests",
            limit: 100,
            remaining: 4,
            used: 96,
            percentUsed: 96,
            percentRemaining: 4,
            warningThreshold: 10,
            resetAt: null,
          },
        ],
      },
      "2026-04-17T10:00:05.000Z",
    );

    const decision = evaluateRuntimeLimitGate(toRuntimeProfileResponse(findRuntimeProfileById(profile!.id)!), 0);
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("uses violated-window reset hint for exact-threshold proactive gate", () => {
    const nowMs = Date.parse("2026-04-17T10:00:00.000Z");
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Threshold profile",
      runtimeId: "openai",
      providerId: "openai",
    });
    persistRuntimeProfileLimitSnapshot(
      profile!.id,
      {
        ...makeLimitSnapshot(),
        source: "api_headers",
        status: "warning",
        precision: "exact",
        profileId: profile!.id,
        primaryScope: "requests",
        resetAt: "2026-04-17T10:05:00.000Z",
        warningThreshold: 10,
        windows: [
          {
            scope: "requests",
            percentRemaining: 4,
            warningThreshold: 10,
            resetAt: "2026-04-17T11:00:00.000Z",
          },
          {
            scope: "tokens",
            percentRemaining: 50,
            warningThreshold: 10,
            resetAt: "2026-04-17T10:05:00.000Z",
          },
        ],
      },
      "2026-04-17T10:00:05.000Z",
    );

    const decision = evaluateRuntimeLimitGate(
      toRuntimeProfileResponse(findRuntimeProfileById(profile!.id)!),
      nowMs,
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("exact_threshold");
    expect(decision.violatedWindow?.scope).toBe("requests");
    expect(decision.futureHint.source).toBe("window_reset_at");
    expect(decision.futureHint.resetAt).toBe("2026-04-17T11:00:00.000Z");
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

  it("persists and clears task runtime limit snapshots", () => {
    const task = createTask({ projectId: "proj-1", title: "T", description: "D" });
    const snapshot = makeLimitSnapshot();

    const persisted = persistTaskRuntimeLimitSnapshot(
      task!.id,
      snapshot,
      "2026-04-17T10:00:05.000Z",
    );
    const mapped = toTaskResponse(persisted!);
    expect(mapped.runtimeLimitSnapshot).toEqual(snapshot);
    expect(mapped.runtimeLimitUpdatedAt).toBe("2026-04-17T10:00:05.000Z");
    expect(persisted!.updatedAt).toBe(task!.updatedAt);

    const cleared = clearTaskRuntimeLimitSnapshot(task!.id, "2026-04-17T11:00:00.000Z");
    const clearedMapped = toTaskResponse(cleared!);
    expect(clearedMapped.runtimeLimitSnapshot).toBeNull();
    expect(clearedMapped.runtimeLimitUpdatedAt).toBe("2026-04-17T11:00:00.000Z");
    expect(cleared!.updatedAt).toBe(task!.updatedAt);
  });

  it("applies proactive runtime gate block only when the CAS guard matches", () => {
    const task = createTask({ projectId: "proj-1", title: "CAS", description: "D" });
    const snapshot = makeLimitSnapshot();

    const applied = blockTaskForRuntimeGateIfEligible({
      taskId: task!.id,
      expectedStatus: "backlog",
      blockedFromStatus: "backlog",
      blockedReason: "Coordinator pre-start runtime gate",
      retryAfter: "2026-04-17T12:00:00.000Z",
      retryCount: 1,
      snapshot,
      persistedAt: "2026-04-17T10:10:00.000Z",
    });

    expect(applied).toBe(true);
    const blocked = findTaskById(task!.id)!;
    expect(blocked.status).toBe("blocked_external");
    expect(blocked.blockedReason).toBe("Coordinator pre-start runtime gate");

    const secondApply = blockTaskForRuntimeGateIfEligible({
      taskId: task!.id,
      expectedStatus: "backlog",
      blockedFromStatus: "backlog",
      blockedReason: "Coordinator pre-start runtime gate",
      retryAfter: "2026-04-17T13:00:00.000Z",
      retryCount: 2,
      snapshot,
      persistedAt: "2026-04-17T10:11:00.000Z",
    });

    expect(secondApply).toBe(false);
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
