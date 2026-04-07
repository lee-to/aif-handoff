import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../types.js";

const runClaudeRuntimeMock = vi.fn();
const runClaudeCliMock = vi.fn();

vi.mock("../adapters/claude/run.js", () => ({
  runClaudeRuntime: (...args: unknown[]) => runClaudeRuntimeMock(...args),
}));

vi.mock("../adapters/claude/cli.js", () => ({
  runClaudeCli: (...args: unknown[]) => runClaudeCliMock(...args),
}));

vi.mock("../adapters/claude/findPath.js", () => ({
  findClaudePath: () => "/usr/local/bin/claude",
}));

vi.mock("../adapters/claude/sessions.js", () => ({
  listClaudeRuntimeSessions: vi.fn().mockResolvedValue([]),
  getClaudeRuntimeSession: vi.fn().mockResolvedValue(null),
  listClaudeRuntimeSessionEvents: vi.fn().mockResolvedValue([]),
}));

const { createClaudeRuntimeAdapter } = await import("../adapters/claude/index.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "claude",
    providerId: "anthropic",
    prompt: "Implement feature",
    options: {},
    ...overrides,
  };
}

describe("Claude adapter — transport routing and capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runClaudeRuntimeMock.mockResolvedValue({ outputText: "sdk-output", sessionId: "sess-1" });
    runClaudeCliMock.mockResolvedValue({ outputText: "cli-output", sessionId: "sess-2" });
  });

  describe("transport routing", () => {
    it("routes to SDK transport by default", async () => {
      const adapter = createClaudeRuntimeAdapter();
      const result = await adapter.run(createRunInput());

      expect(result.outputText).toBe("sdk-output");
      expect(runClaudeRuntimeMock).toHaveBeenCalledTimes(1);
      expect(runClaudeCliMock).not.toHaveBeenCalled();
    });

    it("routes to CLI transport when transport is 'cli'", async () => {
      const adapter = createClaudeRuntimeAdapter();
      const result = await adapter.run(createRunInput({ transport: "cli" }));

      expect(result.outputText).toBe("cli-output");
      expect(runClaudeCliMock).toHaveBeenCalledTimes(1);
      expect(runClaudeRuntimeMock).not.toHaveBeenCalled();
    });

    it("routes to SDK for API transport (both use Agent SDK)", async () => {
      const adapter = createClaudeRuntimeAdapter();
      const result = await adapter.run(createRunInput({ transport: "api" }));

      expect(result.outputText).toBe("sdk-output");
      expect(runClaudeRuntimeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getEffectiveCapabilities", () => {
    it("returns full capabilities for SDK transport", () => {
      const adapter = createClaudeRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.SDK);

      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsSessionList).toBe(true);
      expect(caps.supportsAgentDefinitions).toBe(true);
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsApprovals).toBe(true);
    });

    it("returns CLI capabilities — agent defs yes, streaming no", () => {
      const adapter = createClaudeRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.CLI);

      expect(caps.supportsAgentDefinitions).toBe(true);
      expect(caps.supportsResume).toBe(true);
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsApprovals).toBe(false);
    });

    it("returns API capabilities — no agent defs, no sessions", () => {
      const adapter = createClaudeRuntimeAdapter();
      const caps = adapter.getEffectiveCapabilities!(RuntimeTransport.API);

      expect(caps.supportsAgentDefinitions).toBe(false);
      expect(caps.supportsResume).toBe(false);
      expect(caps.supportsSessionList).toBe(false);
    });
  });

  describe("supported transports", () => {
    it("lists SDK, CLI, and API", () => {
      const adapter = createClaudeRuntimeAdapter();
      expect(adapter.descriptor.supportedTransports).toEqual([
        RuntimeTransport.SDK,
        RuntimeTransport.CLI,
        RuntimeTransport.API,
      ]);
    });
  });

  describe("resume via CLI", () => {
    it("routes resume to CLI when transport is cli", async () => {
      const adapter = createClaudeRuntimeAdapter();
      await adapter.resume!({
        ...createRunInput({ transport: "cli" }),
        sessionId: "sess-existing",
      } as any);

      expect(runClaudeCliMock).toHaveBeenCalledTimes(1);
      const input = runClaudeCliMock.mock.calls[0][0];
      expect(input.resume).toBe(true);
    });
  });
});
