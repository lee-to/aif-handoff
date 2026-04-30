import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeCapabilities,
  checkRuntimeCapabilities,
  checkRuntimeSessionForkSupport,
  RuntimeCapabilityError,
  RuntimeTransport,
  UsageReporting,
} from "../index.js";

describe("runtime capability checks", () => {
  const capabilities = {
    supportsResume: true,
    supportsSessionFork: false,
    supportsSessionList: true,
    supportsAgentDefinitions: false,
    supportsStreaming: true,
    supportsModelDiscovery: false,
    supportsApprovals: true,
    supportsCustomEndpoint: true,
    usageReporting: UsageReporting.NONE,
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

  it("logs a fork skip when the runtime does not support session fork", () => {
    const warn = vi.fn();
    const result = checkRuntimeSessionForkSupport({
      runtimeId: "openrouter",
      transport: RuntimeTransport.API,
      capabilities,
      hasForkSessionMethod: false,
      sourceSessionId: "warm-session-1",
      logger: { warn },
    });

    expect(result).toEqual({ ok: false, skipReason: "unsupported_capability" });
    expect(warn).toHaveBeenCalledWith(
      {
        runtimeId: "openrouter",
        transport: RuntimeTransport.API,
        hasSourceSessionId: true,
        skipReason: "unsupported_capability",
      },
      "Runtime session fork requested but unavailable",
    );
  });

  it("logs a fork skip when the adapter method is missing", () => {
    const warn = vi.fn();
    const result = checkRuntimeSessionForkSupport({
      runtimeId: "custom",
      transport: RuntimeTransport.SDK,
      capabilities: { ...capabilities, supportsSessionFork: true },
      hasForkSessionMethod: false,
      sourceSessionId: null,
      logger: { warn },
    });

    expect(result).toEqual({ ok: false, skipReason: "missing_adapter_method" });
    expect(warn).toHaveBeenCalledWith(
      {
        runtimeId: "custom",
        transport: RuntimeTransport.SDK,
        hasSourceSessionId: false,
        skipReason: "missing_adapter_method",
      },
      "Runtime session fork requested but unavailable",
    );
  });

  it("passes when capability and adapter method are present", () => {
    const debug = vi.fn();
    const result = checkRuntimeSessionForkSupport({
      runtimeId: "claude",
      transport: RuntimeTransport.SDK,
      capabilities: { ...capabilities, supportsSessionFork: true },
      hasForkSessionMethod: true,
      sourceSessionId: "warm-session-1",
      logger: { debug },
    });

    expect(result).toEqual({ ok: true });
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
