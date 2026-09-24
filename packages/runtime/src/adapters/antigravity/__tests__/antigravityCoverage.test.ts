import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { mockExistsSync, mockExecFileSync, mockExecFile } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: any) => {
      if (mockExistsSync.getMockImplementation()) {
        return mockExistsSync(p);
      }
      return actual.existsSync(p);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: any[]) => {
      if (mockExecFileSync.getMockImplementation()) {
        return mockExecFileSync(...args);
      }
      return (actual.execFileSync as any)(...args);
    },
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

import { findAntigravityPath, probeAntigravityCli } from "../findPath.js";
import { createAntigravityRuntimeAdapter } from "../index.js";
import { classifyAntigravityRuntimeError } from "../errors.js";
import { discoverAntigravityModels, clearDiscoveredModelsCache } from "../models.js";
import * as cliModule from "../cli.js";
import { TEST_USAGE_CONTEXT } from "../../../__tests__/helpers/usageContext.js";
import { RuntimeTransport, type RuntimeRunInput } from "../../../types.js";

describe("Antigravity Adapter Coverage Suite", () => {
  let tempDir: string;

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
    tempDir = path.join(
      os.tmpdir(),
      `agy-cov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    mockExistsSync.mockReset();
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // =========================================================================
  // Binary Discovery & Probing (findPath.ts)
  // =========================================================================
  describe("Path Resolution & Probe (findPath.ts)", () => {
    it("returns ANTIGRAVITY_BIN_PATH if environment variable is set and exists", () => {
      const fakeExe = path.join(tempDir, "custom-agy.exe");
      fs.writeFileSync(fakeExe, "");
      const oldEnv = process.env.ANTIGRAVITY_BIN_PATH;
      try {
        process.env.ANTIGRAVITY_BIN_PATH = fakeExe;
        const result = findAntigravityPath();
        expect(result).toBe(fakeExe);
      } finally {
        if (oldEnv !== undefined) process.env.ANTIGRAVITY_BIN_PATH = oldEnv;
        else delete process.env.ANTIGRAVITY_BIN_PATH;
      }
    });

    it("finds agy from candidate paths if candidate exists", () => {
      mockExistsSync.mockImplementation((p) => {
        const norm = String(p).replace(/\\/g, "/");
        return norm.includes("agy/bin/agy.exe") || norm.includes("/usr/local/bin/agy");
      });

      const found = findAntigravityPath();
      expect(found).toBeDefined();
    });

    it("resolves from PATH locator, ignoring batch scripts and missing paths", () => {
      const validExe = path.join(tempDir, "agy.exe");
      fs.writeFileSync(validExe, "");

      mockExistsSync.mockImplementation((p) => {
        if (p === validExe) return true;
        return false;
      });

      mockExecFileSync.mockReturnValue(
        `"C:\\ignored\\script.cmd"\n"${validExe}"\n"C:\\missing\\agy.exe"`,
      );

      const found = findAntigravityPath();
      expect(found).toBe(validExe);
    });

    it("returns undefined when PATH locator throws", () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Command failed");
      });

      const found = findAntigravityPath();
      expect(found).toBeUndefined();
    });

    it("probeAntigravityCli rejects batch script extensions cross-platform", () => {
      const probeCmd = probeAntigravityCli("/usr/bin/agy.cmd");
      expect(probeCmd.ok).toBe(false);
      expect(probeCmd.error).toContain("prohibited");

      const probeBat = probeAntigravityCli("/opt/agy.bat");
      expect(probeBat.ok).toBe(false);
      expect(probeBat.error).toContain("prohibited");
    });

    it("probeAntigravityCli returns version on success", () => {
      mockExecFileSync.mockReturnValue("1.2.5\n");
      const probe = probeAntigravityCli("agy.exe");
      expect(probe.ok).toBe(true);
      expect(probe.version).toBe("1.2.5");
    });

    it("probeAntigravityCli returns error message on spawn failure", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Command not found");
      });
      const probe = probeAntigravityCli("nonexistent.exe");
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe("Command not found");
    });
  });

  // =========================================================================
  // Diagnosis & Adapter Methods (index.ts)
  // =========================================================================
  describe("Adapter Methods & Error Diagnosis (index.ts)", () => {
    const adapter = createAntigravityRuntimeAdapter();

    it("diagnoses unknown model error", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("invalid model selection (--model 'gemini-unknown')"),
      });
      expect(diag).toContain("Selected model is not recognized by Antigravity CLI");
    });

    it("diagnoses model not recognized error with model keyword", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("model 'foo' is not found"),
      });
      expect(diag).toContain("Selected model is not recognized by Antigravity CLI");
    });

    it("diagnoses auth errors", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("User not logged in"),
      });
      expect(diag).toContain("Run 'agy' or login interactively");
    });

    it("diagnoses capacity / 503 errors", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("HTTP 503 Service Unavailable: capacity exhausted"),
      });
      expect(diag).toContain("Gemini model capacity is temporarily exhausted");
    });

    it("diagnoses ENOENT errors", async () => {
      const diag = await adapter.diagnoseError!({
        error: Object.assign(new Error("spawn agy.exe ENOENT"), { code: "ENOENT" }),
      });
      expect(diag).toContain("Ensure 'agy.exe' is installed in PATH");
    });

    it("diagnoses cannot find binary errors", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("cannot find executable agy"),
      });
      expect(diag).toContain("Ensure 'agy.exe' is installed in PATH");
    });

    it("diagnoses generic errors without known suggestions", async () => {
      const diag = await adapter.diagnoseError!({
        error: new Error("Unclassified internal glitch"),
        stderrTail: "stack trace details",
      });
      expect(diag).toContain("Antigravity execution error: Unclassified internal glitch");
      expect(diag).toContain("Stderr tail:\nstack trace details");
      expect(diag).not.toContain("Recommendation:");
    });

    it("diagnoses pre-classified errors using structured category and adapterCode", async () => {
      const modelErr = classifyAntigravityRuntimeError(new Error("invalid model selection"));
      const diagModel = await adapter.diagnoseError!({ error: modelErr });
      expect(diagModel).toContain("Selected model is not recognized by Antigravity CLI");

      const authErr = classifyAntigravityRuntimeError(new Error("User unauthorized"), 401);
      const diagAuth = await adapter.diagnoseError!({ error: authErr });
      expect(diagAuth).toContain("Run 'agy' or login interactively");

      const enoentErr = classifyAntigravityRuntimeError(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      );
      const diagEnoent = await adapter.diagnoseError!({ error: enoentErr });
      expect(diagEnoent).toContain("Ensure 'agy.exe' is installed in PATH");
    });

    it("validateConnection returns failure when probeAntigravityCli fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("CLI probe failed");
      });
      const result = await adapter.validateConnection!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: "C:\\tools\\agy.exe" },
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Antigravity CLI is not reachable");
    });

    it("supports fallback logger methods", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let capturedLogger: cliModule.AntigravityCliLogger | undefined;
      const runSpy = vi
        .spyOn(cliModule, "runAntigravityCli")
        .mockImplementation(async (_input, logger) => {
          capturedLogger = logger;
          return { outputText: "ok", sessionId: "s1", usage: null };
        });

      const customAdapter = createAntigravityRuntimeAdapter();
      expect(customAdapter.descriptor.id).toBe("antigravity");
      expect(customAdapter.getEffectiveCapabilities!(RuntimeTransport.CLI).supportsResume).toBe(
        true,
      );
      expect(customAdapter.sanitizeInput!("<command-name>cmd</command-name>hello")).toBe("hello");

      await customAdapter.run({
        runtimeId: "antigravity",
        providerId: "google",
        prompt: "test",
        options: {},
        projectRoot: "/tmp",
        cwd: "/tmp",
        usageContext: TEST_USAGE_CONTEXT,
      });

      capturedLogger?.debug?.({ foo: 1 }, "debug msg");
      capturedLogger?.info?.({ foo: 1 }, "info msg");
      capturedLogger?.warn?.({ foo: 1 }, "warn msg");
      capturedLogger?.error?.({ foo: 1 }, "error msg");

      expect(debugSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      runSpy.mockRestore();
    });

    it("adapter run and resume delegate to runAntigravityCli", async () => {
      const spy = vi.spyOn(cliModule, "runAntigravityCli").mockResolvedValue({
        outputText: "success",
        sessionId: "session-1",
        usage: null,
      });

      const adapter = createAntigravityRuntimeAdapter({ executablePath: "/bin/agy" });
      const input: RuntimeRunInput = {
        runtimeId: "antigravity",
        prompt: "test",
        usageContext: TEST_USAGE_CONTEXT,
      };

      const resRun = await adapter.run(input);
      expect(resRun.outputText).toBe("success");
      expect(spy).toHaveBeenCalledWith(input, expect.anything(), {
        pathToAntigravityExecutable: "/bin/agy",
      });

      const resResume = await adapter.resume!({ ...input, sessionId: "session-1" });
      expect(resResume.outputText).toBe("success");
    });
  });

  // =========================================================================
  // Model Discovery Caching & Edges (models.ts)
  // =========================================================================
  describe("Model Discovery Caching & Edges (models.ts)", () => {
    beforeEach(() => {
      clearDiscoveredModelsCache();
    });

    it("parses agy models output, caches it, and hits cache on subsequent call", async () => {
      mockExecFile.mockImplementation((file: any, args: any, opts: any, cb: any) => {
        const stdout = [
          "Fetching available models...",
          "",
          "gemini-3.8-flash-high\tGemini 3.8 Flash High (Fast & Smart)",
          "custom-unknown-model\tCustom Experimental",
          "model-without-label",
        ].join("\n");
        cb(null, { stdout, stderr: "" });
      });

      const models1 = await discoverAntigravityModels({ cliPath: "agy.exe" });
      expect(models1.length).toBe(3);
      expect(models1[0].id).toBe("gemini-3.8-flash-high");
      expect(models1[1].id).toBe("custom-unknown-model");
      expect(models1[1].metadata?.contextWindow).toBe(1048576);
      expect(models1[2].id).toBe("model-without-label");

      // Second call should hit in-memory cache without calling execFile again
      mockExecFile.mockClear();
      const models2 = await discoverAntigravityModels({ cliPath: "agy.exe" });
      expect(models2).toBe(models1);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("falls back to ANTIGRAVITY_MODELS when agy models returns empty lines", async () => {
      mockExecFile.mockImplementation((file: any, args: any, opts: any, cb: any) => {
        cb(null, { stdout: "\nFetching available models...\n\n", stderr: "" });
      });

      const models = await discoverAntigravityModels({ cliPath: "agy.exe" });
      expect(models.length).toBe(14);
    });
  });

  // =========================================================================
  // Error Classification edge cases (errors.ts)
  // =========================================================================
  describe("Error Classification Edge Cases (errors.ts)", () => {
    it("returns existing AntigravityRuntimeAdapterError unchanged", () => {
      const orig = classifyAntigravityRuntimeError(new Error("original"));
      const classified = classifyAntigravityRuntimeError(orig);
      expect(classified).toBe(orig);
    });

    it("classifies error with httpStatus 429", () => {
      const err = classifyAntigravityRuntimeError("Rate limit exceeded", 429);
      expect(err.adapterCode).toBe("ANTIGRAVITY_RATE_LIMIT");
      expect(err.category).toBe("rate_limit");
      expect(err.httpStatus).toBe(429);
    });

    it("classifies cannot find pattern as transport", () => {
      const err = classifyAntigravityRuntimeError("cannot find executable");
      expect(err.adapterCode).toBe("ANTIGRAVITY_CLI_NOT_FOUND");
      expect(err.category).toBe("transport");
    });

    it("classifies no such file pattern as transport", () => {
      const err = classifyAntigravityRuntimeError("no such file or directory");
      expect(err.adapterCode).toBe("ANTIGRAVITY_CLI_NOT_FOUND");
      expect(err.category).toBe("transport");
    });
  });
});
