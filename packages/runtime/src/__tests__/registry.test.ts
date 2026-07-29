import { afterEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "url";
import { tmpdir } from "os";
import { join } from "path";
import { unlink, writeFile } from "fs/promises";
import {
  RuntimeError,
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
  RuntimeRegistry,
  createRuntimeRegistry,
  DEFAULT_RUNTIME_CAPABILITIES,
  resolveRuntimeModuleRegistrar,
  UsageReporting,
  UsageSource,
  RuntimeTransport,
  type RuntimeAdapter,
  type RuntimeRunInput,
  type RuntimeUsageEvent,
  type RuntimeUsageSink,
} from "../index.js";
import { CODEX_MODEL_EFFORT_LEVELS, resolveModelEffortOption } from "../modelEffort.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

function createAdapter(runtimeId: string, providerId = "provider"): RuntimeAdapter {
  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: runtimeId,
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
    },
    async run() {
      return { outputText: "ok", usage: null };
    },
  };
}

describe("resolveRuntimeModuleRegistrar", () => {
  it("supports direct function export", () => {
    const registrar = () => undefined;
    expect(resolveRuntimeModuleRegistrar(registrar)).toBe(registrar);
  });

  it("supports named registerRuntimeModule export", () => {
    const registrar = () => undefined;
    expect(resolveRuntimeModuleRegistrar({ registerRuntimeModule: registrar })).toBe(registrar);
  });

  it("supports default function export", () => {
    const registrar = () => undefined;
    expect(resolveRuntimeModuleRegistrar({ default: registrar })).toBe(registrar);
  });

  it("supports default object export with registerRuntimeModule", () => {
    const registrar = () => undefined;
    expect(resolveRuntimeModuleRegistrar({ default: { registerRuntimeModule: registrar } })).toBe(
      registrar,
    );
  });

  it("returns null for unsupported exports", () => {
    expect(resolveRuntimeModuleRegistrar({})).toBeNull();
    expect(resolveRuntimeModuleRegistrar("invalid")).toBeNull();
  });
});

describe("RuntimeRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers and resolves runtimes", () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const registry = createRuntimeRegistry({
      logger,
      builtInAdapters: [createAdapter("Claude"), createAdapter("codex")],
    });

    expect(registry.hasRuntime("claude")).toBe(true);
    expect(registry.hasRuntime("codex")).toBe(true);
    expect(registry.resolveRuntime("CLAUDE").descriptor.id).toBe("Claude");
    expect(registry.tryResolveRuntime("missing")).toBeNull();
    expect(registry.listRuntimes().map((item) => item.id)).toEqual(["Claude", "codex"]);
    expect(logger.debug).toHaveBeenCalled();
  });

  it("validates dynamic effort against cached selected-model metadata", async () => {
    const listModels = vi.fn(async () => [
      {
        id: "gpt-current",
        metadata: {
          supportsEffort: true,
          supportedEffortLevels: ["ultra"],
        },
      },
    ]);
    const run = vi.fn(async (input: RuntimeRunInput) => {
      expect(
        resolveModelEffortOption(
          input.options ?? {},
          "modelReasoningEffort",
          CODEX_MODEL_EFFORT_LEVELS,
        ),
      ).toBe("ultra");
      return { outputText: "ok", usage: null };
    });
    const registry = createRuntimeRegistry({
      modelEffortDiscoveryEnabled: true,
      builtInAdapters: [
        {
          descriptor: {
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            capabilities: {
              ...DEFAULT_RUNTIME_CAPABILITIES,
              supportsModelDiscovery: true,
            },
          },
          listModels,
          run,
        },
      ],
    });
    const adapter = registry.resolveRuntime("codex");
    const input = {
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: RuntimeTransport.CLI,
      prompt: "run",
      model: "gpt-current",
      options: { modelReasoningEffort: " Ultra " },
      usageContext: TEST_USAGE_CONTEXT,
    };

    await adapter.run(input);
    await adapter.run(input);

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.not.objectContaining({
          modelReasoningEffort: expect.anything(),
        }),
      }),
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops stale effort with a structured warning before adapter execution", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const run = vi.fn(async (input: RuntimeRunInput) => {
      expect(input.options).not.toHaveProperty("modelReasoningEffort");
      return { outputText: "ok", usage: null };
    });
    const registry = createRuntimeRegistry({
      logger,
      modelEffortDiscoveryEnabled: true,
      builtInAdapters: [
        {
          descriptor: {
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            capabilities: {
              ...DEFAULT_RUNTIME_CAPABILITIES,
              supportsModelDiscovery: true,
            },
          },
          async listModels() {
            return [
              {
                id: "gpt-current",
                metadata: {
                  supportsEffort: true,
                  supportedEffortLevels: ["low", "high"],
                },
              },
            ];
          },
          run,
        },
      ],
    });

    await registry.resolveRuntime("codex").run({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: RuntimeTransport.CLI,
      prompt: "run",
      model: "gpt-current",
      options: { modelReasoningEffort: "bogus" },
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredEffort: "bogus",
        model: "gpt-current",
        reasonCode: "unsupported_model_effort",
        validationSource: "discovery",
      }),
      "Ignoring unsupported runtime model effort",
    );
  });

  it("uses the fallback allowlist when model discovery is unavailable", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const run = vi.fn(async (input: RuntimeRunInput) => {
      expect(
        resolveModelEffortOption(
          input.options ?? {},
          "modelReasoningEffort",
          CODEX_MODEL_EFFORT_LEVELS,
        ),
      ).toBe("high");
      return { outputText: "ok", usage: null };
    });
    const registry = createRuntimeRegistry({
      logger,
      modelEffortDiscoveryEnabled: true,
      builtInAdapters: [
        {
          descriptor: {
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            capabilities: {
              ...DEFAULT_RUNTIME_CAPABILITIES,
              supportsModelDiscovery: true,
            },
          },
          async listModels() {
            throw new Error("discovery failed");
          },
          run,
        },
      ],
    });

    await registry.resolveRuntime("codex").run({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: RuntimeTransport.CLI,
      prompt: "run",
      model: "gpt-current",
      options: { modelReasoningEffort: "high" },
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-current",
        reasonCode: "model_effort_discovery_unavailable",
      }),
      "Runtime model effort discovery was unavailable; using fallback allowlist",
    );
  });

  it("hides dynamic effort metadata while the rollout flag is disabled", async () => {
    const adapter = createAdapter("codex", "openai");
    adapter.descriptor.capabilities.supportsModelDiscovery = true;
    adapter.listModels = async () => [
      {
        id: "gpt-current",
        metadata: {
          supportsEffort: true,
          supportedEffortLevels: ["low", "ultra"],
          defaultEffort: "low",
          contextLength: 200_000,
        },
      },
    ];
    const registry = createRuntimeRegistry({
      builtInAdapters: [adapter],
      modelEffortDiscoveryEnabled: false,
    });
    const resolvedAdapter = registry.resolveRuntime("codex");
    if (!resolvedAdapter.listModels) {
      throw new Error("Codex listModels wrapper is missing");
    }

    await expect(
      resolvedAdapter.listModels({
        runtimeId: "codex",
        providerId: "openai",
      }),
    ).resolves.toEqual([
      {
        id: "gpt-current",
        metadata: {
          contextLength: 200_000,
        },
      },
    ]);
  });

  it("throws for duplicate runtime registration without replace", () => {
    const registry = new RuntimeRegistry();
    registry.registerRuntime(createAdapter("claude"));
    expect(() => registry.registerRuntime(createAdapter("claude"))).toThrow(
      RuntimeRegistrationError,
    );
  });

  it("supports replace registration", () => {
    const registry = new RuntimeRegistry();
    registry.registerRuntime(createAdapter("claude", "provider-a"));
    registry.registerRuntime(createAdapter("claude", "provider-b"), { replace: true });
    expect(registry.resolveRuntime("claude").descriptor.providerId).toBe("provider-b");
  });

  it("throws when runtime id is empty", () => {
    const registry = new RuntimeRegistry();
    expect(() => registry.registerRuntime(createAdapter("   "))).toThrow(RuntimeRegistrationError);
  });

  it("throws when resolving unknown runtime", () => {
    const registry = new RuntimeRegistry();
    expect(() => registry.resolveRuntime("missing")).toThrow(RuntimeResolutionError);
  });

  it("removes runtime and reports false on second removal", () => {
    const registry = new RuntimeRegistry();
    registry.registerRuntime(createAdapter("claude"));
    expect(registry.removeRuntime("claude")).toBe(true);
    expect(registry.removeRuntime("claude")).toBe(false);
  });

  it("applies runtime module via registrar", async () => {
    const registry = new RuntimeRegistry();
    await registry.applyRuntimeModule((innerRegistry: RuntimeRegistry) => {
      innerRegistry.registerRuntime(createAdapter("from-module"));
    }, "unit-module");

    expect(registry.hasRuntime("from-module")).toBe(true);
  });

  it("rejects invalid runtime module export", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const registry = new RuntimeRegistry({ logger });

    await expect(registry.applyRuntimeModule({}, "invalid-module")).rejects.toBeInstanceOf(
      RuntimeModuleValidationError,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { moduleId: "invalid-module" },
      "Invalid runtime module export",
    );
  });

  it("wraps runtime module execution errors", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const registry = new RuntimeRegistry({ logger });
    const failure = new Error("boom");

    await expect(
      registry.applyRuntimeModule(() => {
        throw failure;
      }, "failing-module"),
    ).rejects.toBeInstanceOf(RuntimeModuleLoadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: "failing-module" }),
      "Failed while executing runtime module",
    );
  });

  it("loads runtime module by specifier", async () => {
    const registry = new RuntimeRegistry();
    const modulePath = join(
      tmpdir(),
      `runtime-module-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );

    await writeFile(
      modulePath,
      `
export function registerRuntimeModule(registry) {
  registry.registerRuntime({
    descriptor: {
      id: "from-file-module",
      providerId: "provider",
      displayName: "From File",
      capabilities: {
        supportsResume: false,
        supportsSessionFork: false,
        supportsSessionList: false,
        supportsAgentDefinitions: false,
        supportsStreaming: false,
        supportsModelDiscovery: false,
        supportsApprovals: false,
        supportsCustomEndpoint: false
      }
    },
    run: async () => ({ outputText: "ok" })
  });
}
`,
      "utf8",
    );

    try {
      await registry.registerRuntimeModule(pathToFileURL(modulePath).href);
      expect(registry.hasRuntime("from-file-module")).toBe(true);
    } finally {
      await unlink(modulePath);
    }
  });

  it("wraps import errors for invalid module specifier", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const registry = new RuntimeRegistry({ logger });

    await expect(
      registry.registerRuntimeModule("file:///definitely-missing-runtime-module.mjs"),
    ).rejects.toBeInstanceOf(RuntimeModuleLoadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ moduleSpecifier: "file:///definitely-missing-runtime-module.mjs" }),
      "Failed to load runtime module",
    );
  });

  it("uses fallback logger when no logger is provided", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new RuntimeRegistry();

    registry.registerRuntime(createAdapter("fallback"));
    expect(registry.hasRuntime("fallback")).toBe(true);

    await expect(registry.applyRuntimeModule({}, "fallback-invalid")).rejects.toBeInstanceOf(
      RuntimeModuleValidationError,
    );
    expect(debugSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("skill command prefix decorator", () => {
  it("transforms /aif-* prompts to $aif-* for adapters with skillCommandPrefix $", async () => {
    const runMock = vi.fn().mockResolvedValue({ outputText: "ok" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: runMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("codex");

    await resolved.run({
      runtimeId: "codex",
      prompt: "/aif-plan fast @PLAN.md\n\nAlso /aif-review",
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedPrompt = runMock.mock.calls[0][0].prompt;
    expect(passedPrompt).toContain("$aif-plan fast");
    expect(passedPrompt).toContain("$aif-review");
    expect(passedPrompt).not.toContain("/aif-plan");
    expect(passedPrompt).not.toContain("/aif-review");
  });

  it("does not transform prompts for adapters without skillCommandPrefix", async () => {
    const runMock = vi.fn().mockResolvedValue({ outputText: "ok" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "claude",
        providerId: "anthropic",
        displayName: "Claude",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
      },
      run: runMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("claude");

    await resolved.run({
      runtimeId: "claude",
      prompt: "/aif-plan fast",
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(runMock.mock.calls[0][0].prompt).toBe("/aif-plan fast");
  });

  it("transforms prompts in resume() calls too", async () => {
    const resumeMock = vi.fn().mockResolvedValue({ outputText: "resumed" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: vi.fn(),
      resume: resumeMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("codex");

    await resolved.resume!({
      runtimeId: "codex",
      prompt: "/aif-implement @PLAN.md",
      sessionId: "session-1",
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(resumeMock.mock.calls[0][0].prompt).toBe("$aif-implement @PLAN.md");
  });

  it("preserves adapter descriptor on wrapped adapter", () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: vi.fn(),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("codex");

    expect(resolved.descriptor.id).toBe("codex");
    expect(resolved.descriptor.skillCommandPrefix).toBe("$");
    expect(resolved.descriptor.providerId).toBe("openai");
  });

  it("does not wrap resume when adapter has no resume method", () => {
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: vi.fn(),
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("codex");

    expect(resolved.resume).toBeUndefined();
  });

  it("transforms via tryResolveRuntime as well", async () => {
    const runMock = vi.fn().mockResolvedValue({ outputText: "ok" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: runMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.tryResolveRuntime("codex")!;

    await resolved.run({
      runtimeId: "codex",
      prompt: "/aif-commit",
      usageContext: TEST_USAGE_CONTEXT,
    });

    expect(runMock.mock.calls[0][0].prompt).toBe("$aif-commit");
  });

  it("does not transform /etc or /usr paths", async () => {
    const runMock = vi.fn().mockResolvedValue({ outputText: "ok" });
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "codex",
        providerId: "openai",
        displayName: "Codex",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
        skillCommandPrefix: "$",
      },
      run: runMock,
    };

    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const resolved = registry.resolveRuntime("codex");

    await resolved.run({
      runtimeId: "codex",
      prompt: "Check /etc/config\n/aif-plan fast",
      usageContext: TEST_USAGE_CONTEXT,
    });

    const passedPrompt = runMock.mock.calls[0][0].prompt;
    expect(passedPrompt).toContain("/etc/config");
    expect(passedPrompt).toContain("$aif-plan fast");
  });
});

describe("registry usage pipeline", () => {
  function createCapturingSink(): RuntimeUsageSink & { events: RuntimeUsageEvent[] } {
    const events: RuntimeUsageEvent[] = [];
    return {
      events,
      record(event) {
        events.push(event);
      },
    };
  }

  function createFakeAdapter(options: {
    runtimeId?: string;
    usageReporting: (typeof UsageReporting)[keyof typeof UsageReporting];
    returnedUsage: RuntimeUsageEvent["usage"] | null;
  }): RuntimeAdapter {
    return {
      descriptor: {
        id: options.runtimeId ?? "fake",
        providerId: "fake-provider",
        displayName: "Fake",
        capabilities: {
          ...DEFAULT_RUNTIME_CAPABILITIES,
          usageReporting: options.usageReporting,
        },
      },
      async run() {
        return { outputText: "ok", usage: options.returnedUsage };
      },
    };
  }

  const sampleUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.0042 };

  it("forwards usage to the sink when adapter returns non-null usage", async () => {
    const sink = createCapturingSink();
    const registry = createRuntimeRegistry({
      usageSink: sink,
      builtInAdapters: [
        createFakeAdapter({ usageReporting: UsageReporting.FULL, returnedUsage: sampleUsage }),
      ],
    });
    const adapter = registry.resolveRuntime("fake");

    await adapter.run({
      runtimeId: "fake",
      prompt: "hello",
      workflowKind: "test",
      usageContext: { source: UsageSource.TEST, projectId: "p-1", taskId: "t-1" },
    });

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event.usage).toEqual(sampleUsage);
    expect(event.context.source).toBe(UsageSource.TEST);
    expect(event.context.projectId).toBe("p-1");
    expect(event.context.taskId).toBe("t-1");
    expect(event.runtimeId).toBe("fake");
    expect(event.usageReporting).toBe(UsageReporting.FULL);
    expect(event.recordedAt).toBeInstanceOf(Date);
  });

  it("does not call sink when adapter returns null usage", async () => {
    const sink = createCapturingSink();
    const registry = createRuntimeRegistry({
      usageSink: sink,
      builtInAdapters: [
        createFakeAdapter({ usageReporting: UsageReporting.PARTIAL, returnedUsage: null }),
      ],
    });
    const adapter = registry.resolveRuntime("fake");

    await adapter.run({
      runtimeId: "fake",
      prompt: "hello",
      usageContext: { source: UsageSource.TEST },
    });

    expect(sink.events).toHaveLength(0);
  });

  it("logs error when adapter declared FULL but returns null usage", async () => {
    const sink = createCapturingSink();
    const error = vi.fn();
    const registry = createRuntimeRegistry({
      usageSink: sink,
      logger: { debug: vi.fn(), warn: vi.fn(), error },
      builtInAdapters: [
        createFakeAdapter({ usageReporting: UsageReporting.FULL, returnedUsage: null }),
      ],
    });
    const adapter = registry.resolveRuntime("fake");

    await adapter.run({
      runtimeId: "fake",
      prompt: "hello",
      usageContext: { source: UsageSource.TEST },
    });

    expect(sink.events).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ usageReporting: UsageReporting.FULL }),
      expect.stringContaining("FULL"),
    );
  });

  it("warns when adapter declared NONE but returns non-null usage", async () => {
    const sink = createCapturingSink();
    const warn = vi.fn();
    const registry = createRuntimeRegistry({
      usageSink: sink,
      logger: { debug: vi.fn(), warn, error: vi.fn() },
      builtInAdapters: [
        createFakeAdapter({ usageReporting: UsageReporting.NONE, returnedUsage: sampleUsage }),
      ],
    });
    const adapter = registry.resolveRuntime("fake");

    await adapter.run({
      runtimeId: "fake",
      prompt: "hello",
      usageContext: { source: UsageSource.TEST },
    });

    // Still records the event — we take the data when we get it — but warns.
    expect(sink.events).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ usageReporting: UsageReporting.NONE }),
      expect.stringContaining("NONE"),
    );
  });

  it("swallows sink errors without breaking the caller", async () => {
    const error = vi.fn();
    const throwingSink: RuntimeUsageSink = {
      record() {
        throw new Error("sink exploded");
      },
    };
    const registry = createRuntimeRegistry({
      usageSink: throwingSink,
      logger: { debug: vi.fn(), warn: vi.fn(), error },
      builtInAdapters: [
        createFakeAdapter({ usageReporting: UsageReporting.FULL, returnedUsage: sampleUsage }),
      ],
    });
    const adapter = registry.resolveRuntime("fake");

    const result = await adapter.run({
      runtimeId: "fake",
      prompt: "hello",
      usageContext: { source: UsageSource.TEST },
    });

    expect(result.outputText).toBe("ok");
    expect(error).toHaveBeenCalled();
  });
});

describe("runtime error classes", () => {
  it("exposes consistent codes and names", () => {
    const cause = new Error("root-cause");
    const base = new RuntimeError("base", "RUNTIME_BASE", cause);
    const registration = new RuntimeRegistrationError("registration failed");
    const resolution = new RuntimeResolutionError("resolution failed");
    const validation = new RuntimeModuleValidationError("validation failed");
    const load = new RuntimeModuleLoadError("load failed");

    expect(base.name).toBe("RuntimeError");
    expect(base.code).toBe("RUNTIME_BASE");
    expect((base as Error & { cause?: unknown }).cause).toBe(cause);
    expect(registration.code).toBe("RUNTIME_REGISTRATION_ERROR");
    expect(resolution.code).toBe("RUNTIME_RESOLUTION_ERROR");
    expect(validation.code).toBe("RUNTIME_MODULE_VALIDATION_ERROR");
    expect(load.code).toBe("RUNTIME_MODULE_LOAD_ERROR");
  });
});

describe("Language directive injection", () => {
  async function setupTempProject(languageBlock: string | null): Promise<string> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "registry-lang-test-"));
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    if (languageBlock !== null) {
      writeFileSync(join(root, ".ai-factory", "config.yaml"), languageBlock);
    }
    const { clearProjectConfigCache } = await import("@aif/shared");
    clearProjectConfigCache();
    return root;
  }

  function createCapturingAdapter(): {
    adapter: RuntimeAdapter;
    captured: {
      run: string | undefined;
      resume: string | undefined;
      fork: string | undefined;
      forkPrompt: string | undefined;
    };
  } {
    const captured = {
      run: undefined as string | undefined,
      resume: undefined as string | undefined,
      fork: undefined as string | undefined,
      forkPrompt: undefined as string | undefined,
    };
    const adapter: RuntimeAdapter = {
      descriptor: {
        id: "capture",
        providerId: "capture-provider",
        displayName: "Capture",
        capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES, supportsResume: true },
      },
      async run(input) {
        captured.run = input.execution?.systemPromptAppend;
        return { outputText: "ok", usage: null };
      },
      async resume(input) {
        captured.resume = input.execution?.systemPromptAppend;
        return { outputText: "ok", usage: null };
      },
      async forkSession(input) {
        captured.fork = input.execution?.systemPromptAppend;
        captured.forkPrompt = input.prompt;
        return {
          outputText: "forked",
          sessionId: "child-session",
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, costUsd: 0.001 },
        };
      },
    };
    return { adapter, captured };
  }

  function buildRunInput(projectRoot: string | undefined, existingAppend?: string) {
    return {
      runtimeId: "capture",
      providerId: "capture-provider",
      profileId: null,
      workflowKind: "test",
      transport: "sdk" as const,
      prompt: "hello",
      projectRoot,
      execution: existingAppend ? { systemPromptAppend: existingAppend } : undefined,
      usageContext: TEST_USAGE_CONTEXT,
    };
  }

  it("appends directive to systemPromptAppend when artifacts=ru", async () => {
    const root = await setupTempProject("language:\n  artifacts: ru\n");
    const { adapter, captured } = createCapturingAdapter();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.run(buildRunInput(root, "PROJECT SCOPE RULE"));

    expect(captured.run).toBeDefined();
    expect(captured.run).toMatch(/^PROJECT SCOPE RULE\n\n/);
    expect(captured.run).toContain("Russian");
    expect(captured.run).toContain("identifiers");
  });

  it("injects directive with no existing systemPromptAppend", async () => {
    const root = await setupTempProject("language:\n  artifacts: ru\n");
    const { adapter, captured } = createCapturingAdapter();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.run(buildRunInput(root));

    expect(captured.run).toBeDefined();
    expect(captured.run).toContain("Russian");
    expect(captured.run).not.toMatch(/^\n\n/);
  });

  it("does not modify systemPromptAppend when artifacts=en", async () => {
    const root = await setupTempProject("language:\n  artifacts: en\n");
    const { adapter, captured } = createCapturingAdapter();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.run(buildRunInput(root, "SCOPE RULE"));

    expect(captured.run).toBe("SCOPE RULE");
  });

  it("skips injection when projectRoot is missing", async () => {
    const { adapter, captured } = createCapturingAdapter();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.run(buildRunInput(undefined, "SCOPE"));

    expect(captured.run).toBe("SCOPE");
  });

  it("also injects on resume()", async () => {
    const root = await setupTempProject("language:\n  artifacts: ru\n");
    const { adapter, captured } = createCapturingAdapter();
    const registry = createRuntimeRegistry({ builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.resume!({ ...buildRunInput(root, "S"), sessionId: "sid-1" });

    expect(captured.resume).toBeDefined();
    expect(captured.resume).toContain("Russian");
    expect(captured.resume).toMatch(/^S\n\n/);
  });

  it("applies prompt and language transforms and records usage on forkSession()", async () => {
    const root = await setupTempProject("language:\n  artifacts: ru\n");
    const events: RuntimeUsageEvent[] = [];
    const { adapter, captured } = createCapturingAdapter();
    adapter.descriptor.skillCommandPrefix = "$";
    adapter.descriptor.capabilities = {
      ...adapter.descriptor.capabilities,
      supportsSessionFork: true,
      usageReporting: UsageReporting.FULL,
    };
    const registry = createRuntimeRegistry({
      usageSink: {
        record(event) {
          events.push(event);
        },
      },
      builtInAdapters: [adapter],
    });
    const wrapped = registry.resolveRuntime("capture");

    await wrapped.forkSession!({
      ...buildRunInput(root, "S"),
      prompt: "/aif-implement @PLAN.md",
      sourceSessionId: "source-session",
    });

    expect(captured.forkPrompt).toBe("$aif-implement @PLAN.md");
    expect(captured.fork).toBeDefined();
    expect(captured.fork).toContain("Russian");
    expect(captured.fork).toMatch(/^S\n\n/);
    expect(events).toHaveLength(1);
    expect(events[0].context.source).toBe(UsageSource.TEST);
    expect(events[0].usage).toEqual({
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
      costUsd: 0.001,
    });
  });

  it("does not throw and logs WARN when config read fails", async () => {
    // Point projectRoot at a path where config.yaml exists but is unreadable
    // garbage — YAML.parse will blow up and we should swallow + warn.
    const root = await setupTempProject(":::not yaml::\n  - [");
    const { adapter, captured } = createCapturingAdapter();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const registry = createRuntimeRegistry({ logger, builtInAdapters: [adapter] });
    const wrapped = registry.resolveRuntime("capture");

    await expect(wrapped.run(buildRunInput(root, "EXISTING"))).resolves.toBeDefined();

    expect(captured.run).toBe("EXISTING");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId: "capture" }),
      expect.stringContaining("skipping language directive"),
    );
  });
});
