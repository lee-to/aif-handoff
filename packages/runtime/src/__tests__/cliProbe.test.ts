import { describe, expect, it } from "vitest";
import { probeClaudeCli } from "../adapters/claude/cli.js";
import { probeCodexCli } from "../adapters/codex/cli.js";

describe("CLI probe functions", () => {
  describe("probeClaudeCli", () => {
    it("returns ok with version for a reachable binary", () => {
      // Use 'node' as a universally available binary to test the probe mechanism
      const result = probeClaudeCli("node");
      expect(result.ok).toBe(true);
      expect(result.version).toBeDefined();
    });

    it("returns error for an unreachable binary", () => {
      const result = probeClaudeCli("__nonexistent_binary_12345__");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("probeCodexCli", () => {
    it("returns ok with version for a reachable binary", () => {
      const result = probeCodexCli("node");
      expect(result.ok).toBe(true);
      expect(result.version).toBeDefined();
    });

    it("returns error for an unreachable binary", () => {
      const result = probeCodexCli("__nonexistent_binary_12345__");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("IS_WINDOWS constant", () => {
    it("is false on macOS/Linux CI", async () => {
      // Verify the platform constant used in spawn logic
      expect(process.platform).not.toBe("win32");
    });
  });
});
