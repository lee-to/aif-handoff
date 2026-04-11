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
const mockCreateRuntimeMemoryCache = vi.fn((options: unknown) => ({ options }));
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

const mockFindProjectById = vi.fn();
const mockFindRuntimeProfileById = vi.fn();
const mockFindTaskById = vi.fn();
const mockResolveEffectiveRuntimeProfile = vi.fn();
const mockToRuntimeProfileResponse = vi.fn((row: unknown) => row);

vi.mock("@aif/shared", () => ({
  logger: vi.fn(() => mockLog),
  getEnv: () => mockGetEnv(),
}));

vi.mock("@aif/runtime", () => ({
  bootstrapRuntimeRegistry: mockBootstrapRuntimeRegistry,
  checkRuntimeCapabilities: mockCheckRuntimeCapabilities,
  createRuntimeMemoryCache: mockCreateRuntimeMemoryCache,
  createRuntimeModelDiscoveryService: mockCreateRuntimeModelDiscoveryService,
  createRuntimeWorkflowSpec: mockCreateRuntimeWorkflowSpec,
  redactResolvedRuntimeProfile: mockRedactResolvedRuntimeProfile,
  resolveAdapterCapabilities: (adapter: { descriptor: { capabilities: unknown } }) =>
    adapter.descriptor.capabilities,
  resolveRuntimeProfile: mockResolveRuntimeProfile,
  RUNTIME_TRUST_TOKEN: Symbol.for("aif.runtime.trust"),
}));

vi.mock("@aif/data", () => ({
  findProjectById: mockFindProjectById,
  findRuntimeProfileById: mockFindRuntimeProfileById,
  findTaskById: mockFindTaskById,
  resolveEffectiveRuntimeProfile: mockResolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse: mockToRuntimeProfileResponse,
}));

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
    expect(mockCreateRuntimeMemoryCache).toHaveBeenNthCalledWith(1, { defaultTtlMs: 30000 });
    expect(mockCreateRuntimeMemoryCache).toHaveBeenNthCalledWith(2, { defaultTtlMs: 15000 });
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
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          bypassPermissions: false,
        }),
      }),
    );
  });
});
