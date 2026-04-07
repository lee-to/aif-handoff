import { describe, expect, it } from "vitest";
import {
  resolveAdapterCapabilities,
  RuntimeTransport,
  DEFAULT_RUNTIME_CAPABILITIES,
  type RuntimeAdapter,
  type RuntimeCapabilities,
} from "../types.js";

function createAdapter(
  capabilities: RuntimeCapabilities,
  getEffective?: (transport: RuntimeTransport) => RuntimeCapabilities,
): RuntimeAdapter {
  return {
    descriptor: {
      id: "test",
      providerId: "test",
      displayName: "Test",
      capabilities,
    },
    run: async () => ({ outputText: "" }),
    ...(getEffective ? { getEffectiveCapabilities: getEffective } : {}),
  };
}

describe("resolveAdapterCapabilities", () => {
  it("returns descriptor capabilities when no transport provided", () => {
    const caps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsResume: true,
    };
    const adapter = createAdapter(caps);
    const result = resolveAdapterCapabilities(adapter);
    expect(result).toBe(caps);
  });

  it("returns descriptor capabilities when adapter has no getEffectiveCapabilities", () => {
    const caps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsStreaming: true,
    };
    const adapter = createAdapter(caps);
    const result = resolveAdapterCapabilities(adapter, RuntimeTransport.SDK);
    expect(result).toBe(caps);
  });

  it("calls getEffectiveCapabilities when transport is provided and method exists", () => {
    const descriptorCaps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsResume: false,
    };
    const sdkCaps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsResume: true,
      supportsSessionList: true,
    };
    const adapter = createAdapter(descriptorCaps, (transport) => {
      if (transport === RuntimeTransport.SDK) return sdkCaps;
      return descriptorCaps;
    });

    const result = resolveAdapterCapabilities(adapter, RuntimeTransport.SDK);
    expect(result).toBe(sdkCaps);
    expect(result.supportsResume).toBe(true);
  });

  it("falls back to descriptor when transport is undefined even with getEffectiveCapabilities", () => {
    const descriptorCaps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
    };
    const adapter = createAdapter(descriptorCaps, () => ({
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsResume: true,
    }));

    const result = resolveAdapterCapabilities(adapter, undefined);
    expect(result).toBe(descriptorCaps);
  });

  it("returns different capabilities for different transports", () => {
    const cliCaps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsStreaming: true,
    };
    const sdkCaps: RuntimeCapabilities = {
      ...DEFAULT_RUNTIME_CAPABILITIES,
      supportsResume: true,
      supportsSessionList: true,
      supportsStreaming: true,
    };
    const adapter = createAdapter(cliCaps, (transport) => {
      return transport === RuntimeTransport.SDK ? sdkCaps : cliCaps;
    });

    expect(resolveAdapterCapabilities(adapter, RuntimeTransport.SDK).supportsResume).toBe(true);
    expect(resolveAdapterCapabilities(adapter, RuntimeTransport.CLI).supportsResume).toBe(false);
  });
});
