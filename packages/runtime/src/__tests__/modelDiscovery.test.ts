import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeModelDiscoveryService,
  createRuntimeRegistry,
  createRuntimeMemoryCache,
  RuntimeValidationError,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
} from "../index.js";

function createResolvedProfile(
  runtimeId = "stub-runtime",
  overrides: Record<string, unknown> = {},
) {
  return {
    source: "task_override",
    profileId: "profile-1",
    runtimeId,
    providerId: "stub-provider",
    transport: "sdk" as const,
    baseUrl: null,
    apiKeyEnvVar: "OPENAI_API_KEY",
    apiKey: "sk-test",
    model: "stub-model",
    headers: {},
    options: {},
    ...overrides,
  };
}

function createDiscoveryLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("runtime model discovery service", () => {
  it("returns cached models on repeated calls", async () => {
    const listModelsMock = vi.fn(async (): Promise<RuntimeModel[]> => [{ id: "model-1" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const logger = createDiscoveryLogger();
    const service = createRuntimeModelDiscoveryService({
      registry,
      cacheTtlMs: 5_000,
      logger,
    });
    const resolved = createResolvedProfile();

    const first = await service.listModels(resolved);
    const second = await service.listModels(resolved);

    expect(first).toEqual([{ id: "model-1" }]);
    expect(second).toEqual([{ id: "model-1" }]);
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ cacheHit: false, forceRefresh: false }),
      "Running uncached runtime model discovery slow path",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheHit: false,
        forceRefresh: false,
        discoveryDurationMs: expect.any(Number),
      }),
      "Runtime model discovery slow path completed",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ cacheHit: true }),
      "Returning cached runtime model list",
    );
  });

  it("bypasses model cache when forceRefresh=true", async () => {
    const listModelsMock = vi
      .fn<() => Promise<RuntimeModel[]>>()
      .mockResolvedValueOnce([{ id: "model-1" }])
      .mockResolvedValueOnce([{ id: "model-2" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const logger = createDiscoveryLogger();
    const service = createRuntimeModelDiscoveryService({
      registry,
      cache: createRuntimeMemoryCache({ defaultTtlMs: 10_000 }),
      logger,
    });
    const resolved = createResolvedProfile();

    const first = await service.listModels(resolved);
    const refreshed = await service.listModels(resolved, true);

    expect(first).toEqual([{ id: "model-1" }]);
    expect(refreshed).toEqual([{ id: "model-2" }]);
    expect(listModelsMock).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ cacheHit: false, forceRefresh: true }),
      "Running uncached runtime model discovery slow path",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when slow path repeats before cache TTL elapses", async () => {
    const listModelsMock = vi
      .fn<() => Promise<RuntimeModel[]>>()
      .mockResolvedValueOnce([{ id: "model-1" }])
      .mockResolvedValueOnce([{ id: "model-1" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };
    const neverHitCache = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    };
    const logger = createDiscoveryLogger();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({
      registry,
      cache: neverHitCache,
      cacheTtlMs: 60_000,
      logger,
    });
    const resolved = createResolvedProfile();

    await service.listModels(resolved);
    await service.listModels(resolved);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheTtlMs: 60_000,
        elapsedSincePreviousSlowPathMs: expect.any(Number),
      }),
      "Runtime model discovery slow path repeated before cache TTL elapsed",
    );
  });

  it("does not reuse cached model discovery results when auth-relevant inputs change", async () => {
    const listModelsMock = vi
      .fn<() => Promise<RuntimeModel[]>>()
      .mockResolvedValueOnce([{ id: "model-auth-a" }])
      .mockResolvedValueOnce([{ id: "model-auth-b" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: true,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry, cacheTtlMs: 10_000 });

    const first = await service.listModels(
      createResolvedProfile("stub-runtime", {
        apiKeyEnvVar: "OPENAI_API_KEY",
      }),
    );
    const second = await service.listModels(
      createResolvedProfile("stub-runtime", {
        apiKeyEnvVar: "ALT_OPENAI_API_KEY",
      }),
    );

    expect(first).toEqual([{ id: "model-auth-a" }]);
    expect(second).toEqual([{ id: "model-auth-b" }]);
    expect(listModelsMock).toHaveBeenCalledTimes(2);
  });

  it("throws RuntimeValidationError when model discovery is unsupported", async () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "no-model-runtime",
        providerId: "stub-provider",
        displayName: "No Model Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: false,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    const resolved = createResolvedProfile("no-model-runtime");

    await expect(service.listModels(resolved)).rejects.toBeInstanceOf(RuntimeValidationError);
  });

  it("wraps listModels failures with RuntimeValidationError", async () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: async () => {
        throw new Error("network down");
      },
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    await expect(service.listModels(createResolvedProfile())).rejects.toMatchObject({
      name: "RuntimeValidationError",
      message: 'Model discovery failed for runtime "stub-runtime"',
    });
  });

  it("passes transport-aware profile details into adapter model discovery", async () => {
    const listModelsMock = vi.fn(async (): Promise<RuntimeModel[]> => [{ id: "remote-model" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: false,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      getEffectiveCapabilities: (transport) => ({
        supportsResume: true,
        supportsSessionList: false,
        supportsAgentDefinitions: false,
        supportsStreaming: false,
        supportsModelDiscovery: transport === "api",
        supportsApprovals: false,
        supportsCustomEndpoint: true,
        usageReporting: UsageReporting.NONE,
      }),
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    const resolved = createResolvedProfile("stub-runtime", {
      transport: "api",
      baseUrl: "https://runtime.example.com",
      apiKeyEnvVar: "RUNTIME_API_KEY",
      apiKey: "sk-transport",
      model: "chosen-model",
      headers: { "x-request-id": "req-1" },
      options: {
        projectRoot: "/tmp/runtime-project",
        customFlag: "enabled",
      },
    });

    const models = await service.listModels(resolved);

    expect(models).toEqual([{ id: "remote-model" }]);
    expect(listModelsMock).toHaveBeenCalledWith({
      runtimeId: "stub-runtime",
      providerId: "stub-provider",
      profileId: "profile-1",
      model: "chosen-model",
      transport: "api",
      projectRoot: "/tmp/runtime-project",
      headers: { "x-request-id": "req-1" },
      options: {
        projectRoot: "/tmp/runtime-project",
        customFlag: "enabled",
        baseUrl: "https://runtime.example.com",
        apiKey: "sk-transport",
        apiKeyEnvVar: "RUNTIME_API_KEY",
      },
      baseUrl: "https://runtime.example.com",
      apiKey: "sk-transport",
      apiKeyEnvVar: "RUNTIME_API_KEY",
    });
  });

  it("stringifies bigint options before fingerprinting discovery cache keys", async () => {
    const listModelsMock = vi.fn(async (): Promise<RuntimeModel[]> => [{ id: "model-1" }]);
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    const resolved = createResolvedProfile("stub-runtime", {
      options: {
        contextWindowTokens: 200_000n,
      },
    });

    await expect(service.listModels(resolved)).resolves.toEqual([{ id: "model-1" }]);
    expect(listModelsMock).toHaveBeenCalledTimes(1);
  });

  it("caches adapter validateConnection results", async () => {
    const validateConnectionMock = vi
      .fn<(input: unknown) => Promise<RuntimeConnectionValidationResult>>()
      .mockResolvedValue({ ok: true, message: "ok" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      validateConnection: validateConnectionMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry, cacheTtlMs: 10_000 });
    const resolved = createResolvedProfile();

    const first = await service.validateConnection(resolved);
    const second = await service.validateConnection(resolved);

    expect(first).toEqual({ ok: true, message: "ok" });
    expect(second).toEqual({ ok: true, message: "ok" });
    expect(validateConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached validation results when auth-relevant inputs change", async () => {
    const validateConnectionMock = vi
      .fn<(input: unknown) => Promise<RuntimeConnectionValidationResult>>()
      .mockResolvedValueOnce({ ok: true, message: "openai-key" })
      .mockResolvedValueOnce({ ok: true, message: "alt-key" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: true,
          supportsApprovals: false,
          supportsCustomEndpoint: true,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      validateConnection: validateConnectionMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry, cacheTtlMs: 10_000 });

    const first = await service.validateConnection(
      createResolvedProfile("stub-runtime", {
        apiKeyEnvVar: "OPENAI_API_KEY",
      }),
    );
    const second = await service.validateConnection(
      createResolvedProfile("stub-runtime", {
        apiKeyEnvVar: "ALT_OPENAI_API_KEY",
      }),
    );

    expect(first).toEqual({ ok: true, message: "openai-key" });
    expect(second).toEqual({ ok: true, message: "alt-key" });
    expect(validateConnectionMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to base validation when adapter has no validateConnection", async () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "stub-provider",
        displayName: "Codex Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: false,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    const resolved = createResolvedProfile("codex", {
      runtimeId: "codex",
      transport: "cli",
      apiKey: null,
      apiKeyEnvVar: "OPENAI_API_KEY",
      options: {},
    });

    const result = await service.validateConnection(resolved);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Runtime profile validation has warnings");
    expect(result.details).toEqual({
      warnings: ["CLI transport is selected but codexCliPath is missing"],
    });
  });

  it("wraps adapter validateConnection failures", async () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "stub-runtime",
        providerId: "stub-provider",
        displayName: "Stub Runtime",
        capabilities: {
          supportsResume: true,
          supportsSessionList: false,
          supportsAgentDefinitions: false,
          supportsStreaming: false,
          supportsModelDiscovery: false,
          supportsApprovals: false,
          supportsCustomEndpoint: false,
          usageReporting: UsageReporting.NONE,
        },
      },
      run: async () => ({ outputText: "ok", usage: null }),
      validateConnection: async () => {
        throw new Error("validation transport failure");
      },
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry });
    await expect(service.validateConnection(createResolvedProfile())).rejects.toMatchObject({
      name: "RuntimeValidationError",
      message: 'Connection validation failed for runtime "stub-runtime"',
    });
  });
});
