import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeCapabilities,
  checkRuntimeCapabilities,
  RuntimeCapabilityError,
} from "../index.js";

describe("runtime capability checks", () => {
  const capabilities = {
    supportsResume: true,
    supportsSessionList: true,
    supportsAgentDefinitions: false,
    supportsStreaming: true,
    supportsModelDiscovery: false,
    supportsApprovals: true,
    supportsCustomEndpoint: true,
  };

  it("returns ok when all required capabilities are present", () => {
    const result = checkRuntimeCapabilities({
      runtimeId: "claude",
      workflowKind: "implementer",
      capabilities,
      required: ["supportsResume", "supportsApprovals"],
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns ok and logs when no capabilities are required", () => {
    const debug = vi.fn();
    const result = checkRuntimeCapabilities({
      runtimeId: "claude",
      capabilities,
      required: [],
      logger: { debug },
    });

    expect(result.ok).toBe(true);
    expect(result.required).toEqual([]);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("reports missing capabilities", () => {
    const warn = vi.fn();
    const result = checkRuntimeCapabilities({
      runtimeId: "claude",
      workflowKind: "planner",
      capabilities,
      required: ["supportsAgentDefinitions"],
      logger: { warn },
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["supportsAgentDefinitions"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("deduplicates required capability list", () => {
    const result = checkRuntimeCapabilities({
      runtimeId: "claude",
      workflowKind: "planner",
      capabilities,
      required: ["supportsApprovals", "supportsApprovals", "supportsResume"],
    });

    expect(result.required).toEqual(["supportsApprovals", "supportsResume"]);
  });

  it("throws RuntimeCapabilityError when assert fails", () => {
    expect(() =>
      assertRuntimeCapabilities({
        runtimeId: "claude",
        workflowKind: "planner",
        capabilities,
        required: ["supportsAgentDefinitions"],
      }),
    ).toThrow(RuntimeCapabilityError);
  });
});
