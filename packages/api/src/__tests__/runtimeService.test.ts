import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockGetEnv = vi.fn(() => ({
  AGENT_BYPASS_PERMISSIONS: false,
  AIF_RUNTIME_MODULES: [] as string[],
  AIF_DEFAULT_RUNTIME_ID: "claude",
  AIF_DEFAULT_PROVIDER_ID: "anthropic",
  API_RUNTIME_START_TIMEOUT_MS: 60_000,
  API_RUNTIME_RUN_TIMEOUT_MS: 120_000,
}));

const mockCheckRuntimeCapabilities = vi.fn(() => ({ ok: true, missing: [] as string[] }));
const mockCreateRuntimeMemoryCache = vi.fn((options: unknown) => {
  const store = new Map<string, unknown>();
  return {
    options,
    get: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
});
const mockCreateRuntimeModelDiscoveryService = vi.fn(() => ({ kind: "discovery" }));
const mockRegistryResolveRuntime = vi.fn();
const mockRegistryRegisterRuntimeModule = vi.fn();
const mockBootstrapRuntimeRegistry = vi.fn(() =>
  Promise.resolve({
    resolveRuntime: mockRegistryResolveRuntime,
    registerRuntimeModule: mockRegistryRegisterRuntimeModule,
  }),
);
const mockCreateRuntimeWorkflowSpec = vi.fn(
  (input: {
    workflowKind: string;
    prompt: string;
    requiredCapabilities?: string[];
    systemPromptAppend?: string;
    sessionReusePolicy?: string;
  }) => ({
    workflowKind: input.workflowKind,
    promptInput: { prompt: input.prompt },
    requiredCapabilities: input.requiredCapabilities ?? [],
    sessionReusePolicy: input.sessionReusePolicy ?? "never",
    systemPromptAppend: input.systemPromptAppend,
  }),
);
const mockRedactResolvedRuntimeProfile = vi.fn((profile: Record<string, unknown>) => profile);
const mockResolveRuntimeProfile = vi.fn();
const mockNormalizeRuntimeLimitSnapshot = vi.fn((snapshot: unknown) => snapshot);
const mockPersistRuntimeProfileLimitSnapshot = vi.fn();
const mockClearRuntimeProfileLimitSnapshot = vi.fn();
const mockBroadcast = vi.fn();

const mockFindProjectById = vi.fn();
const mockFindRuntimeProfileById = vi.fn();
const mockFindTaskById = vi.fn();
const mockGetAppDefaultRuntimeProfileId = vi.fn();
const mockResolveEffectiveRuntimeProfile = vi.fn();
const mockToRuntimeProfileResponse = vi.fn((row: unknown) => row);

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    logger: vi.fn(() => mockLog),
    getEnv: () => mockGetEnv(),
  };
});

vi.mock("@aif/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/runtime")>();
  return {
    ...actual,
    bootstrapRuntimeRegistry: mockBootstrapRuntimeRegistry,
    checkRuntimeCapabilities: mockCheckRuntimeCapabilities,
    createRuntimeMemoryCache: mockCreateRuntimeMemoryCache,
    createRuntimeModelDiscoveryService: mockCreateRuntimeModelDiscoveryService,
    createRuntimeWorkflowSpec: mockCreateRuntimeWorkflowSpec,
    normalizeRuntimeLimitSnapshot: mockNormalizeRuntimeLimitSnapshot,
    redactResolvedRuntimeProfile: mockRedactResolvedRuntimeProfile,
    resolveAdapterCapabilities: (adapter: { descriptor: { capabilities: unknown } }) =>
      adapter.descriptor.capabilities,
    resolveRuntimeProfile: mockResolveRuntimeProfile,
  };
});

vi.mock("@aif/data", () => ({
  clearRuntimeProfileLimitSnapshot: mockClearRuntimeProfileLimitSnapshot,
  findProjectById: mockFindProjectById,
  findRuntimeProfileById: mockFindRuntimeProfileById,
  findTaskById: mockFindTaskById,
  persistRuntimeProfileLimitSnapshot: mockPersistRuntimeProfileLimitSnapshot,
  getAppDefaultRuntimeProfileId: mockGetAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile: mockResolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse: mockToRuntimeProfileResponse,
  createDbUsageSink: () => ({ record: vi.fn() }),
}));

vi.mock("../ws.js", () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const { RuntimeExecutionError } = await import("@aif/runtime");

function createAdapter() {
  return {
    descriptor: {
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
    run: vi.fn().mockResolvedValue({ outputText: "ok" }),
  };
}

function createResolvedProfile(overrides: Record<string, unknown> = {}) {
  return {
    source: "project_default",
    profileId: "profile-1",
    runtimeId: "claude",
    providerId: "anthropic",
    transport: "sdk",
    model: "claude-sonnet",
    baseUrl: null,
    apiKey: null,
    apiKeyEnvVar: null,
    headers: {},
    options: { mode: "safe" },
    ...overrides,
  };
}

function createLimitSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    source: "sdk_event",
    status: "warning",
    precision: "heuristic",
    checkedAt: "2026-04-17T00:00:00.000Z",
    providerId: "anthropic",
    runtimeId: "claude",
    profileId: "profile-1",
    primaryScope: "time",
    resetAt: "2026-04-17T01:00:00.000Z",
    retryAfterSeconds: null,
    warningThreshold: null,
    windows: [
      {
        scope: "time",
        name: "five_hour",
        percentUsed: 96,
        percentRemaining: 4,
        resetAt: "2026-04-17T01:00:00.000Z",
      },
    ],
    providerMeta: { status: "allowed_warning" },
    ...overrides,
  };
}

async function loadRuntimeService() {
  return import("../services/runtime.js");
}

describe("runtime service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    mockFindProjectById.mockReturnValue({ id: "proj-1", rootPath: "/tmp/project" });
    mockGetAppDefaultRuntimeProfileId.mockReturnValue(null);
    mockResolveEffectiveRuntimeProfile.mockReturnValue({
      source: "project_default",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "profile-model",
      },
    });
    mockFindRuntimeProfileById.mockReturnValue({
      id: "profile-1",
      defaultModel: "row-model",
      runtimeId: "claude",
      providerId: "anthropic",
    });
    mockResolveRuntimeProfile.mockReturnValue(createResolvedProfile());
    mockPersistRuntimeProfileLimitSnapshot.mockReset();
    mockClearRuntimeProfileLimitSnapshot.mockReset();
    mockBroadcast.mockReset();
    mockGetEnv.mockReturnValue({
      AGENT_BYPASS_PERMISSIONS: false,
      AIF_RUNTIME_MODULES: [],
      AIF_DEFAULT_RUNTIME_ID: "claude",
      AIF_DEFAULT_PROVIDER_ID: "anthropic",
      API_RUNTIME_START_TIMEOUT_MS: 60_000,
      API_RUNTIME_RUN_TIMEOUT_MS: 120_000,
    });
    mockCheckRuntimeCapabilities.mockReturnValue({ ok: true, missing: [] });
    mockRegistryRegisterRuntimeModule.mockReset();
  });

  it("caches runtime registry and registers built-in adapters once", async () => {
    const runtimeService = await loadRuntimeService();

    const registryA = await runtimeService.getApiRuntimeRegistry();
    const registryB = await runtimeService.getApiRuntimeRegistry();

    expect(registryA).toBe(registryB);
    expect(mockBootstrapRuntimeRegistry).toHaveBeenCalledTimes(1);
  });

  it("loads runtime modules configured via AIF_RUNTIME_MODULES", async () => {
    mockGetEnv.mockReturnValue({
      AGENT_BYPASS_PERMISSIONS: false,
      AIF_RUNTIME_MODULES: ["@org/runtime-a", "file:///runtime-b.mjs"],
      AIF_DEFAULT_RUNTIME_ID: "claude",
      AIF_DEFAULT_PROVIDER_ID: "anthropic",
      API_RUNTIME_START_TIMEOUT_MS: 60_000,
      API_RUNTIME_RUN_TIMEOUT_MS: 120_000,
    });
    const runtimeService = await loadRuntimeService();

    await runtimeService.getApiRuntimeRegistry();

    expect(mockBootstrapRuntimeRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeModules: ["@org/runtime-a", "file:///runtime-b.mjs"],
      }),
    );
  });

  it("caches model discovery service with configured TTL caches", async () => {
    const runtimeService = await loadRuntimeService();

    const serviceA = await runtimeService.getApiRuntimeModelDiscoveryService();
    const serviceB = await runtimeService.getApiRuntimeModelDiscoveryService();

    expect(serviceA).toBe(serviceB);
    expect(mockCreateRuntimeModelDiscoveryService).toHaveBeenCalledTimes(1);
    expect(mockCreateRuntimeMemoryCache).toHaveBeenCalledWith({ defaultTtlMs: 30000 });
    expect(mockCreateRuntimeMemoryCache).toHaveBeenCalledWith({ defaultTtlMs: 15000 });
  });

  it("throws when project id cannot be resolved", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindTaskById.mockReturnValue(undefined);

    await expect(
      runtimeService.resolveApiRuntimeContext({
        mode: "task",
        workflow: { workflowKind: "oneshot", requiredCapabilities: [] } as never,
      }),
    ).rejects.toThrow("Project ID is required");
  });

  it("throws when project does not exist", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindProjectById.mockReturnValue(undefined);

    await expect(
      runtimeService.resolveApiRuntimeContext({
        projectId: "proj-missing",
        mode: "task",
        workflow: { workflowKind: "oneshot", requiredCapabilities: [] } as never,
      }),
    ).rejects.toThrow("Project proj-missing not found");
  });

  it("resolves context from task and parses task runtime options", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindTaskById.mockReturnValue({
      id: "task-1",
      projectId: "proj-1",
      modelOverride: "task-model",
      runtimeOptionsJson: '{"temperature":0.2}',
    });

    const context = await runtimeService.resolveApiRuntimeContext({
      taskId: "task-1",
      mode: "task",
      workflow: { workflowKind: "implementer", requiredCapabilities: [] } as never,
    });

    expect(context.selectionSource).toBe("project_default");
    expect(mockResolveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: "task-model",
        runtimeOptionsOverride: { temperature: 0.2 },
      }),
    );
    expect(mockRegistryResolveRuntime).toHaveBeenCalledWith("claude");
  });

  it("passes app-level task defaults into effective runtime resolution", async () => {
    const runtimeService = await loadRuntimeService();
    mockGetAppDefaultRuntimeProfileId.mockReturnValue("app-task-default");

    await runtimeService.resolveApiRuntimeContext({
      projectId: "proj-1",
      mode: "task",
      workflow: { workflowKind: "implementer", requiredCapabilities: [] } as never,
    });

    expect(mockGetAppDefaultRuntimeProfileId).toHaveBeenCalledWith("task");
    expect(mockResolveEffectiveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        mode: "task",
        systemDefaultRuntimeProfileId: "app-task-default",
      }),
    );
  });

  it("passes app-level chat defaults into effective runtime resolution", async () => {
    const runtimeService = await loadRuntimeService();
    mockGetAppDefaultRuntimeProfileId.mockReturnValue("app-chat-default");

    await runtimeService.resolveApiRuntimeContext({
      projectId: "proj-1",
      mode: "chat",
      workflow: { workflowKind: "chat", requiredCapabilities: [] } as never,
    });

    expect(mockGetAppDefaultRuntimeProfileId).toHaveBeenCalledWith("chat");
    expect(mockResolveEffectiveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        mode: "chat",
        systemDefaultRuntimeProfileId: "app-chat-default",
      }),
    );
  });

  it("prefers an explicit runtime profile id over effective chat defaults", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindRuntimeProfileById.mockImplementation((id: string) =>
      id === "profile-pinned"
        ? {
            id,
            runtimeId: "codex",
            providerId: "openai",
            defaultModel: "gpt-5.4",
            enabled: true,
          }
        : null,
    );

    const context = await runtimeService.resolveApiRuntimeContext({
      projectId: "proj-1",
      mode: "chat",
      runtimeProfileId: "profile-pinned",
      workflow: { workflowKind: "chat", requiredCapabilities: [] } as never,
    });

    expect(context.selectionSource).toBe("profile_id");
    expect(mockResolveEffectiveRuntimeProfile).not.toHaveBeenCalled();
    expect(mockResolveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "profile_id",
        profile: expect.objectContaining({
          id: "profile-pinned",
          runtimeId: "codex",
          providerId: "openai",
        }),
      }),
    );
  });

  it("prefers explicit model/runtime options overrides over task values", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindTaskById.mockReturnValue({
      id: "task-1",
      projectId: "proj-1",
      modelOverride: "task-model",
      runtimeOptionsJson: '{"temperature":0.2}',
    });

    await runtimeService.resolveApiRuntimeContext({
      taskId: "task-1",
      mode: "task",
      modelOverride: "request-model",
      runtimeOptionsOverride: { temperature: 0.9 },
      workflow: { workflowKind: "implementer", requiredCapabilities: [] } as never,
    });

    expect(mockResolveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: "request-model",
        runtimeOptionsOverride: { temperature: 0.9 },
      }),
    );
  });

  it("ignores invalid runtime options json from task", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindTaskById.mockReturnValue({
      id: "task-1",
      projectId: "proj-1",
      runtimeOptionsJson: "{not-json",
      modelOverride: null,
    });

    await runtimeService.resolveApiRuntimeContext({
      taskId: "task-1",
      mode: "task",
      workflow: { workflowKind: "planner", requiredCapabilities: [] } as never,
    });

    expect(mockResolveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptionsOverride: undefined,
      }),
    );
  });

  it("ignores array runtime options json from task", async () => {
    const runtimeService = await loadRuntimeService();
    mockFindTaskById.mockReturnValue({
      id: "task-1",
      projectId: "proj-1",
      runtimeOptionsJson: "[1,2,3]",
      modelOverride: null,
    });

    await runtimeService.resolveApiRuntimeContext({
      taskId: "task-1",
      mode: "task",
      workflow: { workflowKind: "planner", requiredCapabilities: [] } as never,
    });

    expect(mockResolveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptionsOverride: undefined,
      }),
    );
  });

  it("assertApiRuntimeCapabilities succeeds when check passes", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();

    expect(() =>
      runtimeService.assertApiRuntimeCapabilities({
        adapter: adapter as never,
        resolvedProfile: createResolvedProfile() as never,
        workflow: { workflowKind: "reviewer", requiredCapabilities: ["supportsResume"] } as never,
      }),
    ).not.toThrow();

    expect(mockCheckRuntimeCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        required: ["supportsResume"],
      }),
    );
  });

  it("assertApiRuntimeCapabilities throws when required capabilities are missing", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockCheckRuntimeCapabilities.mockReturnValue({ ok: false, missing: ["supportsResume"] });

    expect(() =>
      runtimeService.assertApiRuntimeCapabilities({
        adapter: adapter as never,
        resolvedProfile: createResolvedProfile({ runtimeId: "codex" }) as never,
        workflow: { workflowKind: "reviewer", requiredCapabilities: ["supportsResume"] } as never,
      }),
    ).toThrow('Runtime "codex" cannot execute "reviewer": supportsResume');
  });

  it("runs one-shot query with task metadata and non-bypass permissions", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);
    mockResolveRuntimeProfile.mockReturnValue(
      createResolvedProfile({
        model: "task-model",
        baseUrl: "https://example.test",
        apiKey: "token",
        apiKeyEnvVar: "OPENAI_API_KEY",
      }),
    );

    const result = await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      taskId: "task-77",
      prompt: "summarize",
      includePartialMessages: true,
      maxTurns: 4,
      usageContext: { source: "test" },
    });

    expect(result.result.outputText).toBe("ok");
    expect(mockCreateRuntimeWorkflowSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKind: "oneshot",
        sessionReusePolicy: "never",
      }),
    );
    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "claude",
        transport: "sdk",
        workflowKind: "oneshot",
        headers: {},
        options: expect.objectContaining({
          mode: "safe",
          baseUrl: "https://example.test",
          apiKeyEnvVar: "OPENAI_API_KEY",
        }),
        execution: expect.objectContaining({
          startTimeoutMs: 60_000,
          runTimeoutMs: 120_000,
          includePartialMessages: true,
          maxTurns: 4,
          bypassPermissions: false,
          environment: {
            HANDOFF_MODE: "1",
            HANDOFF_TASK_ID: "task-77",
          },
          hooks: expect.objectContaining({
            permissionMode: "acceptEdits",
            allowDangerouslySkipPermissions: false,
            _trustToken: Symbol.for("aif.runtime.trust"),
          }),
        }),
      }),
    );
  });

  it("uses app-level task defaults when resolving the light model", async () => {
    const runtimeService = await loadRuntimeService();
    mockGetAppDefaultRuntimeProfileId.mockReturnValue("app-task-default");

    await runtimeService.resolveApiLightModel("proj-1");

    expect(mockGetAppDefaultRuntimeProfileId).toHaveBeenCalledWith("task");
    expect(mockResolveEffectiveRuntimeProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        mode: "task",
        systemDefaultRuntimeProfileId: "app-task-default",
      }),
    );
  });

  it("passes transport and headers from resolved profile to adapter.run()", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);
    mockResolveRuntimeProfile.mockReturnValue(
      createResolvedProfile({
        transport: "cli",
        headers: { "X-Custom": "value" },
      }),
    );

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "generate roadmap",
      workflowKind: "roadmap-generate",
      usageContext: { source: "test" },
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "cli",
        headers: { "X-Custom": "value" },
      }),
    );
  });

  it("runs one-shot query in bypass mode and omits task id in environment", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);
    mockGetEnv.mockReturnValue({
      AGENT_BYPASS_PERMISSIONS: true,
      AIF_RUNTIME_MODULES: [],
      AIF_DEFAULT_RUNTIME_ID: "claude",
      AIF_DEFAULT_PROVIDER_ID: "anthropic",
      API_RUNTIME_START_TIMEOUT_MS: 90_000,
      API_RUNTIME_RUN_TIMEOUT_MS: 240_000,
    });

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "do work",
      workflowKind: "commit",
      systemPromptAppend: "extra",
      usageContext: { source: "test" },
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          startTimeoutMs: 90_000,
          runTimeoutMs: 240_000,
          includePartialMessages: false,
          systemPromptAppend: "extra",
          bypassPermissions: true,
          environment: { HANDOFF_MODE: "1" },
          hooks: expect.objectContaining({
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            _trustToken: Symbol.for("aif.runtime.trust"),
          }),
        }),
      }),
    );
  });

  it("passes execution.bypassPermissions=false to adapter.run when AGENT_BYPASS_PERMISSIONS is unset", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "do work",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          bypassPermissions: false,
        }),
      }),
    );
  });

  it("persists runtime limit snapshots observed during one-shot execution", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    const snapshot = createLimitSnapshot();
    adapter.run = vi
      .fn()
      .mockImplementation(async (input: { execution?: { onEvent?: (event: unknown) => void } }) => {
        input.execution?.onEvent?.({
          type: "runtime:limit",
          timestamp: "2026-04-17T00:00:01.000Z",
          data: { snapshot },
        });
        return { outputText: "ok", events: [], usage: null };
      });
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "do work",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });

    expect(mockPersistRuntimeProfileLimitSnapshot).toHaveBeenCalledWith(
      "profile-1",
      snapshot,
      expect.any(String),
    );
    expect(mockClearRuntimeProfileLimitSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-1",
        runtimeProfileId: "profile-1",
        taskId: null,
      },
    });
  });

  it("preserves persisted runtime limit state after successful runs without snapshots", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "do work",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });

    expect(mockClearRuntimeProfileLimitSnapshot).not.toHaveBeenCalled();
    expect(mockPersistRuntimeProfileLimitSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("persists runtime limit snapshots from structured execution errors", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    const snapshot = createLimitSnapshot({ status: "blocked" });
    adapter.run = vi.fn().mockRejectedValue(
      new RuntimeExecutionError("rate limited", undefined, "rate_limit", {
        limitSnapshot: snapshot,
      }),
    );
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    await expect(
      runtimeService.runApiRuntimeOneShot({
        projectId: "proj-1",
        projectRoot: "/tmp/project",
        prompt: "do work",
        workflowKind: "commit",
        usageContext: { source: "test" },
      }),
    ).rejects.toThrow("rate limited");

    expect(mockPersistRuntimeProfileLimitSnapshot).toHaveBeenCalledWith(
      "profile-1",
      snapshot,
      expect.any(String),
    );
    expect(mockClearRuntimeProfileLimitSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-1",
        runtimeProfileId: "profile-1",
        taskId: null,
      },
    });
  });

  it("dedupes identical runtime limit writes within the TTL cache window", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    const snapshot = createLimitSnapshot();
    adapter.run = vi.fn().mockResolvedValue({
      outputText: "ok",
      events: [
        {
          type: "runtime:limit",
          timestamp: "2026-04-17T00:00:01.000Z",
          data: { snapshot },
        },
      ],
      usage: null,
    });
    mockRegistryResolveRuntime.mockReturnValue(adapter);

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "first",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });
    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/project",
      prompt: "second",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });

    expect(mockPersistRuntimeProfileLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it("rebroadcasts identical runtime limit state for a different project context", async () => {
    const runtimeService = await loadRuntimeService();
    const adapter = createAdapter();
    const snapshot = createLimitSnapshot({ profileId: "profile-global" });
    adapter.run = vi.fn().mockResolvedValue({
      outputText: "ok",
      events: [
        {
          type: "runtime:limit",
          timestamp: "2026-04-17T00:00:01.000Z",
          data: { snapshot },
        },
      ],
      usage: null,
    });
    mockRegistryResolveRuntime.mockReturnValue(adapter);
    mockResolveRuntimeProfile.mockReturnValue(
      createResolvedProfile({ profileId: "profile-global" }),
    );
    mockFindProjectById.mockImplementation((projectId: string) => ({
      id: projectId,
      rootPath: `/tmp/${projectId}`,
    }));

    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-1",
      projectRoot: "/tmp/proj-1",
      prompt: "first",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });
    await runtimeService.runApiRuntimeOneShot({
      projectId: "proj-2",
      projectRoot: "/tmp/proj-2",
      prompt: "second",
      workflowKind: "commit",
      usageContext: { source: "test" },
    });

    expect(mockPersistRuntimeProfileLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).toHaveBeenNthCalledWith(1, {
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-1",
        runtimeProfileId: "profile-global",
        taskId: null,
      },
    });
    expect(mockBroadcast).toHaveBeenNthCalledWith(2, {
      type: "project:runtime_limit_updated",
      payload: {
        projectId: "proj-2",
        runtimeProfileId: "profile-global",
        taskId: null,
      },
    });
  });
});
