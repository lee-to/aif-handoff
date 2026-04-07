import { describe, expect, it } from "vitest";
import { getResultSessionId, DEFAULT_RUNTIME_CAPABILITIES } from "../types.js";
import type { RuntimeCapabilities, RuntimeRunResult } from "../types.js";

function caps(overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return { ...DEFAULT_RUNTIME_CAPABILITIES, ...overrides };
}

describe("getResultSessionId", () => {
  it("returns sessionId from result", () => {
    const result: RuntimeRunResult = { outputText: "ok", sessionId: "sess-1" };
    expect(getResultSessionId(result)).toBe("sess-1");
  });

  it("falls back to session.id when sessionId is null", () => {
    const result: RuntimeRunResult = {
      outputText: "ok",
      sessionId: null,
      session: {
        id: "sess-2",
        runtimeId: "test",
        providerId: "test",
        createdAt: "",
        updatedAt: "",
      },
    };
    expect(getResultSessionId(result)).toBe("sess-2");
  });

  it("returns null when neither sessionId nor session present", () => {
    const result: RuntimeRunResult = { outputText: "ok" };
    expect(getResultSessionId(result)).toBeNull();
  });

  it("returns null when capabilities say no session support", () => {
    const result: RuntimeRunResult = { outputText: "ok", sessionId: "sess-3" };
    const noCaps = caps({ supportsResume: false, supportsSessionList: false });
    expect(getResultSessionId(result, noCaps)).toBeNull();
  });

  it("returns sessionId when supportsResume is true", () => {
    const result: RuntimeRunResult = { outputText: "ok", sessionId: "sess-4" };
    const resumeCaps = caps({ supportsResume: true });
    expect(getResultSessionId(result, resumeCaps)).toBe("sess-4");
  });

  it("returns sessionId when supportsSessionList is true", () => {
    const result: RuntimeRunResult = { outputText: "ok", sessionId: "sess-5" };
    const listCaps = caps({ supportsSessionList: true });
    expect(getResultSessionId(result, listCaps)).toBe("sess-5");
  });

  it("returns sessionId when no capabilities passed (backwards compat)", () => {
    const result: RuntimeRunResult = { outputText: "ok", sessionId: "sess-6" };
    expect(getResultSessionId(result)).toBe("sess-6");
    expect(getResultSessionId(result, undefined)).toBe("sess-6");
  });
});
