import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "@aif/shared/server";
import { projects, runtimeProfiles, tasks, usageEvents } from "@aif/shared";

const testDb = { current: createTestDb() };

const mockValidateConnection = vi.fn();
const mockListModels = vi.fn();
const mockListRuntimes = vi.fn();
const mockGetCodexAuthIdentity = vi.fn();

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/runtime")>();
  return {
    ...actual,
    getCodexAuthIdentity: (...args: unknown[]) => mockGetCodexAuthIdentity(...args),
  };
});

vi.mock("../services/runtime.js", () => ({
  getApiRuntimeRegistry: () =>
    Promise.resolve({
      listRuntimes: () => mockListRuntimes(),
    }),
  getApiRuntimeModelDiscoveryService: () =>
    Promise.resolve({
      validateConnection: (...args: unknown[]) => mockValidateConnection(...args),
      listModels: (...args: unknown[]) => mockListModels(...args),
    }),
}));

const { runtimeProfilesRouter } = await import("../routes/runtimeProfiles.js");

function createApp() {
  const app = new Hono();
  app.route("/runtime-profiles", runtimeProfilesRouter);
  return app;
}

describe("runtimeProfiles API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockValidateConnection.mockReset();
    mockListModels.mockReset();
    mockListRuntimes.mockReset();
    mockGetCodexAuthIdentity.mockReset();
    mockGetCodexAuthIdentity.mockResolvedValue(null);
    mockValidateConnection.mockResolvedValue({
      ok: true,
      message: "validation ok",
      details: { ping: "ok" },
    });
    mockListModels.mockResolvedValue([{ id: "model-a", label: "Model A" }]);
    mockListRuntimes.mockReturnValue([
      {
        id: "claude",
        providerId: "anthropic",
        displayName: "Claude",
        defaultTransport: "sdk",
        capabilities: {
          supportsResume: true,
          supportsSessionList: true,
          supportsAgentDefinitions: true,
          supportsStreaming: true,
          supportsModelDiscovery: true,
          supportsApprovals: true,
          supportsCustomEndpoint: true,
        },
      },
    ]);
  });

  it("lists runtime descriptors", async () => {
    const res = await app.request("/runtime-profiles/runtimes");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("claude");
    expect(body[0].defaultTransport).toBe("sdk");
  });

  it("creates, updates, fetches and deletes a runtime profile", async () => {
    const createRes = await app.request("/runtime-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Team Claude",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("Team Claude");

    const getRes = await app.request(`/runtime-profiles/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(created.id);

    const updateRes = await app.request(`/runtime-profiles/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultModel: "claude-sonnet-4-5",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.defaultModel).toBe("claude-sonnet-4-5");

    const deleteRes = await app.request(`/runtime-profiles/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const missingRes = await app.request(`/runtime-profiles/${created.id}`);
    expect(missingRes.status).toBe(404);
  });

  it("rejects create/update requests with sensitive-looking header keys", async () => {
    const createRes = await app.request("/runtime-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Sensitive Headers",
        runtimeId: "claude",
        providerId: "anthropic",
        headers: { Authorization: "Bearer temp" },
      }),
    });
    expect(createRes.status).toBe(400);

    const safeCreateRes = await app.request("/runtime-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Safe Headers",
        runtimeId: "claude",
        providerId: "anthropic",
      }),
    });
    expect(safeCreateRes.status).toBe(201);
    const safeProfile = await safeCreateRes.json();

    const updateRes = await app.request(`/runtime-profiles/${safeProfile.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headers: { "x-api-token": "masked" },
      }),
    });
    expect(updateRes.status).toBe(400);
  });

  it("rejects invalid apiKeyEnvVar on create and update", async () => {
    const invalidCreateRes = await app.request("/runtime-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid EnvVar Create",
        runtimeId: "claude",
        providerId: "anthropic",
        apiKeyEnvVar: "invalid env var",
      }),
    });
    expect(invalidCreateRes.status).toBe(400);

    const validCreateRes = await app.request("/runtime-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Valid EnvVar",
        runtimeId: "claude",
        providerId: "anthropic",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
      }),
    });
    expect(validCreateRes.status).toBe(201);
    const validProfile = await validCreateRes.json();

    const invalidUpdateRes = await app.request(`/runtime-profiles/${validProfile.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKeyEnvVar: "still invalid",
      }),
    });
    expect(invalidUpdateRes.status).toBe(400);
  });

  it("lists project + global profiles", async () => {
    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values([
        {
          id: "global-profile",
          projectId: null,
          name: "Global Claude",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "project-profile",
          projectId: "project-1",
          name: "Project Claude",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();

    const res = await app.request(
      "/runtime-profiles?projectId=project-1&includeGlobal=true&enabledOnly=true",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("includes last recorded usage on runtime profile responses", async () => {
    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values({
        id: "profile-usage",
        projectId: "project-1",
        name: "Codex SDK",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        enabled: true,
      })
      .run();
    db.insert(usageEvents)
      .values({
        id: "usage-1",
        source: "chat",
        projectId: "project-1",
        profileId: "profile-usage",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        usageReporting: "full",
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        costUsd: 0.08,
        createdAt: "2026-04-18T10:00:00.000Z",
      })
      .run();

    const res = await app.request("/runtime-profiles?projectId=project-1&includeGlobal=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toEqual(
      expect.objectContaining({
        id: "profile-usage",
        lastUsage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
          costUsd: 0.08,
        },
        lastUsageAt: "2026-04-18T10:00:00.000Z",
      }),
    );
  });

  it("enriches local Codex quota snapshots with auth identity when persisted metadata is stale", async () => {
    mockGetCodexAuthIdentity.mockResolvedValue({
      accountId: "account-codex-1",
      authMode: "chatgpt",
      accountName: "Anton Ageev",
      accountEmail: "ichi.chaik@gmail.com",
      planType: "pro",
    });

    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values({
        id: "profile-codex-sdk",
        projectId: "project-1",
        name: "gpt-5.4",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        enabled: true,
        runtimeLimitSnapshotJson: JSON.stringify({
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T06:24:09.174Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-sdk",
          primaryScope: "time",
          resetAt: "2026-04-18T07:02:25.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 96,
              resetAt: "2026-04-18T07:02:25.000Z",
            },
          ],
          providerMeta: {
            limitId: "codex",
            planType: "pro",
          },
        }),
        runtimeLimitUpdatedAt: "2026-04-18T06:24:09.174Z",
      })
      .run();

    const res = await app.request("/runtime-profiles?projectId=project-1&includeGlobal=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].runtimeLimitSnapshot.providerMeta).toEqual(
      expect.objectContaining({
        accountId: "account-codex-1",
        authMode: "chatgpt",
        accountName: "Anton Ageev",
        accountEmail: "ichi.chaik@gmail.com",
        planType: "pro",
        limitId: "codex",
      }),
    );
  });

  it("applies boolean query sanitization for includeGlobal/enabledOnly flags", async () => {
    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values([
        {
          id: "global-enabled",
          projectId: null,
          name: "Global Enabled",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "project-disabled",
          projectId: "project-1",
          name: "Project Disabled",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: false,
        },
      ])
      .run();

    const res = await app.request(
      "/runtime-profiles?projectId=project-1&includeGlobal=false&enabledOnly=false",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("project-disabled");
  });

  it("validates profile configuration through runtime model-discovery service", async () => {
    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values({
        id: "profile-validate",
        projectId: null,
        name: "Validate Me",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        enabled: true,
      })
      .run();

    const res = await app.request("/runtime-profiles/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: "profile-validate",
        modelOverride: "claude-haiku-3-5",
        forceRefresh: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("validation ok");
    expect(mockValidateConnection).toHaveBeenCalledTimes(1);
  });

  it("lists models through runtime model-discovery service", async () => {
    const res = await app.request("/runtime-profiles/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          name: "Inline",
          runtimeId: "claude",
          providerId: "anthropic",
          transport: "sdk",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe("model-a");
    expect(mockListModels).toHaveBeenCalledTimes(1);
  });

  it("returns effective runtime profile selections for task and chat", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({
        id: "project-1",
        name: "Test Project",
        rootPath: "/tmp/project-1",
        defaultTaskRuntimeProfileId: "profile-task-default",
        defaultChatRuntimeProfileId: "profile-chat-default",
      })
      .run();
    db.insert(runtimeProfiles)
      .values([
        {
          id: "profile-task-default",
          projectId: "project-1",
          name: "Task Default",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
          runtimeLimitSnapshotJson: JSON.stringify({
            source: "api_headers",
            status: "warning",
            precision: "exact",
            checkedAt: "2026-04-17T00:00:00.000Z",
            providerId: "anthropic",
            runtimeId: "claude",
            profileId: "profile-task-default",
            primaryScope: "requests",
            resetAt: "2026-04-17T01:00:00.000Z",
            retryAfterSeconds: null,
            warningThreshold: 10,
            windows: [
              {
                scope: "requests",
                percentRemaining: 8,
                warningThreshold: 10,
                resetAt: "2026-04-17T01:00:00.000Z",
              },
            ],
            providerMeta: null,
          }),
          runtimeLimitUpdatedAt: "2026-04-17T00:00:00.000Z",
        },
        {
          id: "profile-chat-default",
          projectId: "project-1",
          name: "Chat Default",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
        {
          id: "profile-task-override",
          projectId: "project-1",
          name: "Task Override",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: true,
        },
      ])
      .run();
    db.insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        runtimeProfileId: "profile-task-override",
      })
      .run();

    const taskRes = await app.request("/runtime-profiles/effective/task/task-1");
    expect(taskRes.status).toBe(200);
    const taskBody = await taskRes.json();
    expect(taskBody.source).toBe("task_override");
    expect(taskBody.profile.id).toBe("profile-task-override");

    const chatRes = await app.request("/runtime-profiles/effective/chat/project-1");
    expect(chatRes.status).toBe(200);
    const chatBody = await chatRes.json();
    expect(chatBody.source).toBe("project_default");
    expect(chatBody.profile.id).toBe("profile-chat-default");

    const listRes = await app.request("/runtime-profiles?projectId=project-1&includeGlobal=true");
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    const taskDefault = listed.find(
      (profile: { id: string }) => profile.id === "profile-task-default",
    );
    expect(taskDefault.runtimeLimitSnapshot).toEqual(
      expect.objectContaining({
        status: "warning",
        precision: "exact",
        profileId: "profile-task-default",
      }),
    );
    expect(taskDefault.runtimeLimitUpdatedAt).toBe("2026-04-17T00:00:00.000Z");
  });

  it("returns 404 for missing runtime profile/task resources", async () => {
    const getRes = await app.request("/runtime-profiles/missing-id");
    expect(getRes.status).toBe(404);

    const updateRes = await app.request("/runtime-profiles/missing-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "x" }),
    });
    expect(updateRes.status).toBe(404);

    const deleteRes = await app.request("/runtime-profiles/missing-id", { method: "DELETE" });
    expect(deleteRes.status).toBe(404);

    const missingTaskRes = await app.request("/runtime-profiles/effective/task/task-missing");
    expect(missingTaskRes.status).toBe(404);
  });

  it("returns 400 when validate/models request has no profile source", async () => {
    const validateRes = await app.request("/runtime-profiles/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(validateRes.status).toBe(400);

    const modelsRes = await app.request("/runtime-profiles/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(modelsRes.status).toBe(400);
  });

  it("resolves validation profile via project defaults and forwards forceRefresh flag", async () => {
    const db = testDb.current;
    db.insert(projects)
      .values({
        id: "project-effective",
        name: "Effective Project",
        rootPath: "/tmp/effective",
        defaultTaskRuntimeProfileId: "profile-effective",
      })
      .run();
    db.insert(runtimeProfiles)
      .values({
        id: "profile-effective",
        projectId: "project-effective",
        name: "Effective Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      })
      .run();

    const res = await app.request("/runtime-profiles/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-effective",
        apiKey: "temporary-secret",
        forceRefresh: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockValidateConnection).toHaveBeenCalledTimes(1);
    expect(mockValidateConnection.mock.calls[0]?.[1]).toBe(false);
    const [resolvedProfile] = mockValidateConnection.mock.calls[0] ?? [];
    expect(resolvedProfile.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(resolvedProfile.apiKey).toBe("temporary-secret");
  });

  it("returns 400 for project-based validation when no effective profile exists", async () => {
    const res = await app.request("/runtime-profiles/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-without-defaults",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("applies temporary API key fallback env var during model discovery", async () => {
    const res = await app.request("/runtime-profiles/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          name: "No Env Var",
          runtimeId: "claude",
          providerId: "anthropic",
        },
        apiKey: "tmp-key",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockListModels).toHaveBeenCalledTimes(1);
    const [resolvedProfile] = mockListModels.mock.calls[0] ?? [];
    expect(resolvedProfile.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(resolvedProfile.apiKey).toBe("tmp-key");
  });

  it("uses dotted apiKeyEnvVar during validation when profile explicitly sets it", async () => {
    const db = testDb.current;
    db.insert(runtimeProfiles)
      .values({
        id: "legacy-invalid-env-var",
        projectId: null,
        name: "Legacy Invalid EnvVar",
        runtimeId: "claude",
        providerId: "anthropic",
        apiKeyEnvVar: "legacy.invalid",
        enabled: true,
      })
      .run();

    const res = await app.request("/runtime-profiles/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: "legacy-invalid-env-var",
        apiKey: "temporary-key",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockValidateConnection).toHaveBeenCalledTimes(1);
    const [resolvedProfile] = mockValidateConnection.mock.calls[0] ?? [];
    expect(resolvedProfile.apiKeyEnvVar).toBe("legacy.invalid");
    expect(resolvedProfile.apiKey).toBe("temporary-key");
  });
});
