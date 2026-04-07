import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../types.js";

const runCodexCliMock = vi.fn();
const runCodexAgentApiMock = vi.fn();
const runCodexSdkMock = vi.fn();
const validateCodexAgentApiConnectionMock = vi.fn();

vi.mock("../adapters/codex/cli.js", () => ({
  runCodexCli: (...args: unknown[]) => runCodexCliMock(...args),
}));

vi.mock("../adapters/codex/api.js", () => ({
  runCodexAgentApi: (...args: unknown[]) => runCodexAgentApiMock(...args),
  validateCodexAgentApiConnection: (...args: unknown[]) =>
    validateCodexAgentApiConnectionMock(...args),
  listCodexAgentApiModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../adapters/codex/sdk.js", () => ({
  runCodexSdk: (...args: unknown[]) => runCodexSdkMock(...args),
}));

vi.mock("../adapters/codex/sessions.js", () => ({
  listCodexSdkSessions: vi.fn().mockResolvedValue([]),
  getCodexSdkSession: vi.fn().mockResolvedValue(null),
  listCodexSdkSessionEvents: vi.fn().mockResolvedValue([]),
}));

const { createCodexRuntimeAdapter } = await import("../adapters/codex/index.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    options: {},
    ...overrides,
  };
}

describe("Codex adapter — SDK transport and capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCodexCliMock.mockResolvedValue({ outputText: "cli-output", sessionId: null });
    runCodexAgentApiMock.mockResolvedValue({ outputText: "api-output", sessionId: null });
    runCodexSdkMock.mockResolvedValue({ outputText: "sdk-output", sessionId: "thread-1" });
    validateCodexAgentApiConnectionMock.mockResolvedValue({ ok: true });
  });

  describe("transport routing", () => {
    it("routes to SDK transport when transport is 'sdk'", async () => {
      const adapter = createCodexRuntimeAdapter();
      const result = await adapter.run(createRunInput({ transport: "sdk" }));

      expect(result.outputText).toBe("sdk-output");
      expect(runCodexSdkMock).toHaveBeenCalledTimes(1);
      expect(runCodexCliMock).not.toHaveBeenCalled();
      expect(runCodexAgentApiMock).not.toHaveBeenCalled();
    });

    it("routes to CLI transport by default", async () => {
      const adapter = createCodexRuntimeAdapter();
      const result = await adapter.run(createRunInput());

      expect(result.outputText).toBe("cli-output");
      expect(runCodexCliMock).toHaveBeenCalledTimes(1);
    });

    it("routes to API transport when transport is 'api'", async () => {
      const adapter = createCodexRuntimeAdapter();
      const result = await adapter.run(createRunInput({ transport: "api" }));

      expect(result.outputText).toBe("api-output");
      expect(runCodexAgentApiMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getEffectiveCapabilities", () => {
    it("returns SDK capabilities with resume and session support", () => {
      const adapter = createCodexRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.SDK);

      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsSessionList).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsModelDiscovery).toBe(true);
    });

    it("returns CLI capabilities with resume but no session list", () => {
      const adapter = createCodexRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.CLI);

      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsSessionList).toBe(false);
      expect(caps.supportsStreaming).toBe(true);
    });

    it("returns API capabilities without resume or sessions", () => {
      const adapter = createCodexRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.API);

      expect(caps.supportsResume).toBe(false);
      expect(caps.supportsSessionList).toBe(false);
    });

    it("descriptor.capabilities matches CLI default transport", () => {
      const adapter = createCodexRuntimeAdapter();
      expect(adapter.descriptor.capabilities.supportsResume).toBe(true);
      expect(adapter.descriptor.capabilities.supportsSessionList).toBe(false);
    });
  });

  describe("supported transports", () => {
    it("lists SDK, CLI, and API as supported", () => {
      const adapter = createCodexRuntimeAdapter();
      expect(adapter.descriptor.supportedTransports).toEqual([
        RuntimeTransport.SDK,
        RuntimeTransport.CLI,
        RuntimeTransport.API,
      ]);
    });
  });

  describe("session methods", () => {
    it("exposes listSessions method", () => {
      const adapter = createCodexRuntimeAdapter();
      expect(adapter.listSessions).toBeDefined();
    });

    it("exposes getSession method", () => {
      const adapter = createCodexRuntimeAdapter();
      expect(adapter.getSession).toBeDefined();
    });

    it("exposes listSessionEvents method", () => {
      const adapter = createCodexRuntimeAdapter();
      expect(adapter.listSessionEvents).toBeDefined();
    });
  });

  describe("validateConnection — SDK", () => {
    it("validates SDK transport without requiring API key", async () => {
      const adapter = createCodexRuntimeAdapter();
      const result = await adapter.validateConnection!({
        runtimeId: "codex",
        providerId: "openai",
        transport: RuntimeTransport.SDK,
        options: {},
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Codex SDK");
    });

    it("rejects unsupported transport", async () => {
      const adapter = createCodexRuntimeAdapter();
      const result = await adapter.validateConnection!({
        runtimeId: "codex",
        providerId: "openai",
        transport: "grpc" as never,
        options: {},
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("does not support");
    });
  });

  describe("resume via SDK", () => {
    it("passes resume flag through to SDK transport", async () => {
      const adapter = createCodexRuntimeAdapter();
      await adapter.resume!({
        ...createRunInput({ transport: "sdk" }),
        sessionId: "thread-old",
      } as any);

      expect(runCodexSdkMock).toHaveBeenCalledTimes(1);
      const callInput = runCodexSdkMock.mock.calls[0][0];
      expect(callInput.resume).toBe(true);
    });
  });
});
