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
  type RuntimeAdapter,
} from "../index.js";

function createAdapter(runtimeId: string, providerId = "provider"): RuntimeAdapter {
  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: runtimeId,
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
    },
    async run() {
      return { outputText: "ok" };
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
