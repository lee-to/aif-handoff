import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((file: any, args: any, options: any, cb: any) => {
      if (typeof options === "function") {
        cb = options;
      }
      if (mockExecFile.getMockImplementation()) {
        return mockExecFile(file, args, options, cb);
      }
      return (actual.execFile as any)(file, args, options, cb);
    }) as any,
  };
});

import { createAntigravityRuntimeAdapter, registerRuntimeModule } from "../index.js";
import {
  ANTIGRAVITY_MODELS,
  DEFAULT_ANTIGRAVITY_MODEL,
  LIGHT_ANTIGRAVITY_MODEL,
  discoverAntigravityModels,
  clearDiscoveredModelsCache,
  normalizeCacheKey,
} from "../models.js";
import * as findPathModule from "../findPath.js";
import { resolveCliPath } from "../findPath.js";
import { classifyAntigravityRuntimeError } from "../errors.js";
import { resetEnvCache } from "@aif/shared";
import { bootstrapRuntimeRegistry } from "../../../bootstrap.js";
import { UsageReporting, RuntimeTransport } from "../../../types.js";

describe("Antigravity Runtime Adapter", () => {
  describe("Descriptor and capabilities", () => {
    const adapter = createAntigravityRuntimeAdapter();

    it("has correct descriptor properties", () => {
      expect(adapter.descriptor.id).toBe("antigravity");
      expect(adapter.descriptor.providerId).toBe("google");
      expect(adapter.descriptor.displayName).toBe("Google Antigravity");
      expect(adapter.descriptor.defaultTransport).toBe(RuntimeTransport.CLI);
      expect(adapter.descriptor.supportedTransports).toContain(RuntimeTransport.CLI);
      expect(adapter.descriptor.lightModel).toBe(LIGHT_ANTIGRAVITY_MODEL);
      expect(adapter.descriptor.defaultModelPlaceholder).toBe(DEFAULT_ANTIGRAVITY_MODEL);
    });

    it("declares expected capabilities", () => {
      const caps = adapter.descriptor.capabilities;
      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsModelDiscovery).toBe(true);
      expect(caps.supportsNativeSubagentWorkflows).toBe(false);
      expect(caps.supportsSessionFork).toBe(false);
      expect(caps.usageReporting).toBe(UsageReporting.FULL);
      expect(adapter.getEffectiveCapabilities!(RuntimeTransport.CLI)).toEqual(caps);

      expect(adapter.descriptor.supportsProjectInit).toBe(false);
      expect(adapter.descriptor.projectInitAgentName).toBeUndefined();

      const initAdapter = createAntigravityRuntimeAdapter({ supportsProjectInit: true });
      expect(initAdapter.descriptor.supportsProjectInit).toBe(true);
      expect(initAdapter.descriptor.projectInitAgentName).toBe("antigravity");
    });
  });

  describe("Model discovery", () => {
    const adapter = createAntigravityRuntimeAdapter({ executablePath: undefined });

    it("lists all 14 official Antigravity models", async () => {
      const models = await adapter.listModels!({
        runtimeId: "antigravity",
      });

      expect(models.length).toBe(14);
      expect(models.map((m) => m.id)).toEqual(ANTIGRAVITY_MODELS.map((m) => m.id));

      const flashHigh = models.find((m) => m.id === "gemini-3.8-flash-high");
      expect(flashHigh).toBeDefined();
      expect(flashHigh?.metadata?.contextWindow).toBe(1048576);

      const proHigh = models.find((m) => m.id === "gemini-3.1-pro-high");
      expect(proHigh).toBeDefined();
      expect(proHigh?.metadata?.contextWindow).toBe(2097152);

      const proLow = models.find((m) => m.id === "gemini-3.1-pro-low");
      expect(proLow).toBeDefined();

      // Ensure no hallucinated medium pro model
      const proMedium = models.find((m) => m.id === "gemini-3.1-pro-medium");
      expect(proMedium).toBeUndefined();
    });

    it("isolates model discovery cache across distinct executable paths", async () => {
      const pathA = "/opt/tools/agy-alpha";
      const pathB = "/opt/tools/agy-beta";

      mockExecFile.mockImplementation(((
        file: string,
        args: readonly string[] | null | undefined,
        options: unknown,
        callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        if (file === pathA) {
          cb?.(null, { stdout: "model-alpha-only\tModel Alpha Only\n", stderr: "" });
        } else if (file === pathB) {
          cb?.(null, { stdout: "model-beta-only\tModel Beta Only\n", stderr: "" });
        } else {
          cb?.(new Error("unknown binary"), { stdout: "", stderr: "" });
        }
        return {} as any;
      }) as any);

      clearDiscoveredModelsCache();

      const adapterA = createAntigravityRuntimeAdapter({ executablePath: pathA });
      const adapterB = createAntigravityRuntimeAdapter({ executablePath: pathB });

      const modelsA = await adapterA.listModels!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: pathA },
      });
      expect(modelsA.some((m) => m.id === "model-alpha-only")).toBe(true);
      expect(modelsA.some((m) => m.id === "model-beta-only")).toBe(false);

      // Distinct binary path must execute pathB and NOT return cached models from pathA
      const modelsB = await adapterB.listModels!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: pathB },
      });
      expect(modelsB.some((m) => m.id === "model-beta-only")).toBe(true);
      expect(modelsB.some((m) => m.id === "model-alpha-only")).toBe(false);

      // Repeated call for pathA reuses cache without re-executing
      const callCountBefore = mockExecFile.mock.calls.length;
      const modelsA2 = await adapterA.listModels!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: pathA },
      });
      expect(modelsA2.some((m) => m.id === "model-alpha-only")).toBe(true);
      expect(mockExecFile.mock.calls.length).toBe(callCountBefore);

      mockExecFile.mockReset();
      clearDiscoveredModelsCache();
    });

    it("normalizes cache keys in a platform-aware manner", () => {
      // Windows (win32) is case-insensitive
      expect(normalizeCacheKey("  C:\\Tools\\Agy.exe  ", "win32")).toBe("c:\\tools\\agy.exe");
      expect(normalizeCacheKey("c:\\tools\\AGY.EXE", "win32")).toBe("c:\\tools\\agy.exe");

      // POSIX is case-sensitive
      expect(normalizeCacheKey("  /opt/Tools/Agy  ", "linux")).toBe("/opt/Tools/Agy");
      expect(normalizeCacheKey("/opt/tools/agy", "linux")).toBe("/opt/tools/agy");
      expect(normalizeCacheKey("/opt/Tools/Agy", "linux")).not.toBe(
        normalizeCacheKey("/opt/tools/agy", "linux"),
      );
    });

    it("clears cache for a single executable path without affecting other paths", async () => {
      const pathA = "/opt/tools/agy-1";
      const pathB = "/opt/tools/agy-2";

      mockExecFile.mockImplementation(((
        file: string,
        args: readonly string[] | null | undefined,
        options: unknown,
        callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        if (file === pathA) {
          cb?.(null, { stdout: "model-1\tModel 1\n", stderr: "" });
        } else if (file === pathB) {
          cb?.(null, { stdout: "model-2\tModel 2\n", stderr: "" });
        }
        return {} as any;
      }) as any);

      clearDiscoveredModelsCache();

      // Populate cache for both
      await discoverAntigravityModels({ cliPath: pathA });
      await discoverAntigravityModels({ cliPath: pathB });

      const callsAfterPopulate = mockExecFile.mock.calls.length;
      expect(callsAfterPopulate).toBe(2);

      // Invalidate ONLY pathA
      clearDiscoveredModelsCache(pathA);

      // Calling pathB should still be cached (no execFile)
      const cachedB = await discoverAntigravityModels({ cliPath: pathB });
      expect(cachedB.some((m) => m.id === "model-2")).toBe(true);
      expect(mockExecFile.mock.calls.length).toBe(callsAfterPopulate);

      // Calling pathA should re-fetch
      const refreshedA = await discoverAntigravityModels({ cliPath: pathA });
      expect(refreshedA.some((m) => m.id === "model-1")).toBe(true);
      expect(mockExecFile.mock.calls.length).toBe(callsAfterPopulate + 1);

      // clearDiscoveredModelsCache() with no args clears all
      clearDiscoveredModelsCache();
      await discoverAntigravityModels({ cliPath: pathB });
      expect(mockExecFile.mock.calls.length).toBe(callsAfterPopulate + 2);

      mockExecFile.mockReset();
      clearDiscoveredModelsCache();
    });

    it("returns static models without executing CLI when cliPath is empty or whitespace", async () => {
      mockExecFile.mockReset();
      const emptyModels = await discoverAntigravityModels({ cliPath: "   " });
      expect(emptyModels.length).toBe(14);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe("resolveCliPath resolution", () => {
    it("returns options.antigravityCliPath when specified", () => {
      expect(resolveCliPath({ antigravityCliPath: "/opt/agy" })).toBe("/opt/agy");
    });

    it("returns fallbackPath when options are empty and fallback is provided", () => {
      expect(resolveCliPath({}, "/fallback/agy")).toBe("/fallback/agy");
    });

    it("returns platform-appropriate binary name when no path is found", () => {
      const originalPlatform = process.platform;
      const emptyFinder = () => undefined;
      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        expect(resolveCliPath({}, undefined, emptyFinder)).toBe("agy.exe");

        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        expect(resolveCliPath({}, undefined, emptyFinder)).toBe("agy");

        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        expect(resolveCliPath({}, undefined, emptyFinder)).toBe("agy");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });
  });

  describe("Error classification", () => {
    it("classifies numeric HTTP status 503 as rate_limit / ANTIGRAVITY_CAPACITY_UNAVAILABLE", () => {
      const err = classifyAntigravityRuntimeError(
        new Error("Service temporarily unavailable"),
        503,
      );
      expect(err.adapterCode).toBe("ANTIGRAVITY_CAPACITY_UNAVAILABLE");
      expect(err.category).toBe("rate_limit");
    });

    it("classifies capacity 503 errors", () => {
      const err = classifyAntigravityRuntimeError(new Error("503 No capacity available for model"));
      expect(err.adapterCode).toBe("ANTIGRAVITY_CAPACITY_UNAVAILABLE");
      expect(err.category).toBe("rate_limit");
    });

    it("classifies quota exceeded errors", () => {
      const err = classifyAntigravityRuntimeError(
        new Error("ResourceExhausted: Quota exceeded for project"),
      );
      expect(err.adapterCode).toBe("ANTIGRAVITY_RATE_LIMIT");
      expect(err.category).toBe("rate_limit");
    });

    it("classifies authentication errors", () => {
      const err = classifyAntigravityRuntimeError(
        new Error("User is not logged in to Antigravity"),
      );
      expect(err.adapterCode).toBe("ANTIGRAVITY_AUTH_ERROR");
      expect(err.category).toBe("auth");
    });

    it("classifies CLI not found errors", () => {
      const err = classifyAntigravityRuntimeError(new Error("spawn agy.exe ENOENT"));
      expect(err.adapterCode).toBe("ANTIGRAVITY_CLI_NOT_FOUND");
      expect(err.category).toBe("transport");
    });

    it("classifies timeout errors", () => {
      const err = classifyAntigravityRuntimeError(new Error("Execution timed out after 30000ms"));
      expect(err.adapterCode).toBe("ANTIGRAVITY_TIMEOUT");
      expect(err.category).toBe("timeout");
    });

    it("classifies unknown generic errors", () => {
      const err = classifyAntigravityRuntimeError(new Error("Something completely unexpected"));
      expect(err.adapterCode).toBe("ANTIGRAVITY_RUNTIME_ERROR");
      expect(err.category).toBe("unknown");
    });

    it("classifies model not recognized errors as model_not_found instead of CLI missing", () => {
      const err = classifyAntigravityRuntimeError(
        new Error(
          'error: invalid model selection (--model "unknown-model"): model unknown-model is not recognized',
        ),
      );
      expect(err.adapterCode).toBe("ANTIGRAVITY_MODEL_NOT_FOUND");
      expect(err.category).toBe("model_not_found");
    });

    it("classifies ENOENT error object with code property as CLI not found", () => {
      const raw = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
      const err = classifyAntigravityRuntimeError(raw);
      expect(err.adapterCode).toBe("ANTIGRAVITY_CLI_NOT_FOUND");
      expect(err.category).toBe("transport");
    });

    it("diagnoses model not recognized as model error rather than CLI missing", async () => {
      const adapter = createAntigravityRuntimeAdapter();
      const diagnosis = await adapter.diagnoseError!({
        error: new Error("model foo is not recognized"),
      });
      expect(diagnosis).toContain("Selected model is not recognized by Antigravity CLI");
      expect(diagnosis).not.toContain("Ensure 'agy.exe' is installed in PATH");
    });
  });

  describe("Input sanitization", () => {
    const adapter = createAntigravityRuntimeAdapter();

    it("strips internal command tags and system reminders", () => {
      const raw =
        "<system-reminder>secret</system-reminder><command-name>run</command-name>Hello world!";
      const sanitized = adapter.sanitizeInput!(raw);
      expect(sanitized).toBe("Hello world!");
    });
  });

  describe("Bootstrap and Module registration", () => {
    it("is registered as a built-in adapter in bootstrapRuntimeRegistry", async () => {
      process.env.AIF_RUNTIME_ANTIGRAVITY_ENABLED = "true";
      resetEnvCache();
      try {
        const registry = await bootstrapRuntimeRegistry();
        const resolved = registry.resolveRuntime("antigravity");
        expect(resolved).toBeDefined();
        expect(resolved.descriptor.id).toBe("antigravity");
        expect(resolved.descriptor.providerId).toBe("google");
      } finally {
        delete process.env.AIF_RUNTIME_ANTIGRAVITY_ENABLED;
        resetEnvCache();
      }
    });

    it("supports registerRuntimeModule for AIF_RUNTIME_MODULES external loading", () => {
      let registeredAdapter: unknown = null;
      let registeredOptions: unknown = null;

      const fakeRegistry = {
        registerRuntime(adapter: unknown, options?: unknown) {
          registeredAdapter = adapter;
          registeredOptions = options;
        },
      };

      registerRuntimeModule(fakeRegistry as any);
      expect(registeredAdapter).toBeDefined();
      expect((registeredAdapter as any).descriptor.id).toBe("antigravity");
      expect(registeredOptions).toEqual({ source: "module" });
    });
  });

  describe("Connection validation", () => {
    const adapter = createAntigravityRuntimeAdapter({
      executablePath: "/mock/bin/agy.exe",
    });

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("reports success when probeAntigravityCli succeeds", async () => {
      vi.spyOn(findPathModule, "probeAntigravityCli").mockReturnValueOnce({
        ok: true,
        version: "1.2.5",
      });

      const result = await adapter.validateConnection!({
        runtimeId: "antigravity",
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Google Antigravity CLI 1.2.5");
    });

    it("reports failure when probeAntigravityCli fails", async () => {
      vi.spyOn(findPathModule, "probeAntigravityCli").mockReturnValueOnce({
        ok: false,
        error: "CLI not found in PATH",
      });

      const result = await adapter.validateConnection!({
        runtimeId: "antigravity",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Antigravity CLI is not reachable");
      expect(result.message).toContain("CLI not found in PATH");
    });

    it("rejects .cmd batch script due to shell injection protection", async () => {
      const result = await adapter.validateConnection!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: "C:\\tools\\agy.cmd" },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Executing Antigravity via batch script");
    });

    const hasLiveCli = Boolean(process.env.TEST_ANTIGRAVITY_INTEGRATION);
    it.runIf(hasLiveCli)(
      "validates installed agy.exe live when TEST_ANTIGRAVITY_INTEGRATION is enabled",
      async () => {
        const liveAdapter = createAntigravityRuntimeAdapter();
        const result = await liveAdapter.validateConnection!({
          runtimeId: "antigravity",
        });
        expect(result.ok).toBe(true);
        expect(result.message).toContain("Google Antigravity CLI 1.2.5");
      },
    );
  });

  describe("Dynamic model discovery and fallback", () => {
    beforeEach(() => {
      clearDiscoveredModelsCache();
    });

    it("falls back to ANTIGRAVITY_MODELS when cliPath is missing", async () => {
      const models = await discoverAntigravityModels({ cliPath: undefined });
      expect(models.length).toBe(14);
    });

    it("falls back to ANTIGRAVITY_MODELS when CLI execution fails", async () => {
      const models = await discoverAntigravityModels({
        cliPath: "/non-existent/path/to/agy.exe",
        forceRefresh: true,
      });
      expect(models.length).toBe(14);
    });
  });
});
