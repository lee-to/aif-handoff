import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeModelDiscoveryService,
  createRuntimeRegistry,
  createRuntimeMemoryCache,
  RuntimeValidationError,
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
        },
      },
      run: async () => ({ outputText: "ok" }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({ registry, cacheTtlMs: 5_000 });
    const resolved = createResolvedProfile();

    const first = await service.listModels(resolved);
    const second = await service.listModels(resolved);

    expect(first).toEqual([{ id: "model-1" }]);
    expect(second).toEqual([{ id: "model-1" }]);
    expect(listModelsMock).toHaveBeenCalledTimes(1);
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
        },
      },
      run: async () => ({ outputText: "ok" }),
      listModels: listModelsMock,
      validateConnection: async () => ({ ok: true }),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const service = createRuntimeModelDiscoveryService({
      registry,
      cache: createRuntimeMemoryCache({ defaultTtlMs: 10_000 }),
    });
    const resolved = createResolvedProfile();

    const first = await service.listModels(resolved);
    const refreshed = await service.listModels(resolved, true);

    expect(first).toEqual([{ id: "model-1" }]);
    expect(refreshed).toEqual([{ id: "model-2" }]);
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
        },
      },
      run: async () => ({ outputText: "ok" }),
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
        },
      },
      run: async () => ({ outputText: "ok" }),
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
        },
      },
      run: async () => ({ outputText: "ok" }),
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
        },
      },
      run: async () => ({ outputText: "ok" }),
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
        },
      },
      run: async () => ({ outputText: "ok" }),
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
