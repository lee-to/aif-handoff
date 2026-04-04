import { beforeEach, describe, expect, it, vi } from "vitest";

const runCodexCliMock = vi.fn();
const runCodexAgentApiMock = vi.fn();
const validateCodexAgentApiConnectionMock = vi.fn();

vi.mock("../adapters/codex/cli.js", () => ({
  runCodexCli: (...args: unknown[]) => runCodexCliMock(...args),
}));

vi.mock("../adapters/codex/agentapi.js", () => ({
  runCodexAgentApi: (...args: unknown[]) => runCodexAgentApiMock(...args),
  validateCodexAgentApiConnection: (...args: unknown[]) =>
    validateCodexAgentApiConnectionMock(...args),
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

describe("Codex runtime adapter", () => {
  beforeEach(() => {
    runCodexCliMock.mockReset();
    runCodexAgentApiMock.mockReset();
    validateCodexAgentApiConnectionMock.mockReset();
    runCodexCliMock.mockResolvedValue({ outputText: "cli-output", sessionId: "cli-session" });
    runCodexAgentApiMock.mockResolvedValue({
      outputText: "agentapi-output",
      sessionId: "agentapi-session",
    });
    validateCodexAgentApiConnectionMock.mockResolvedValue({
      ok: true,
      message: "agentapi ok",
    });
  });

  it("exposes codex descriptor and capabilities", () => {
    const adapter = createCodexRuntimeAdapter();
    expect(adapter.descriptor.id).toBe("codex");
    expect(adapter.descriptor.providerId).toBe("openai");
    expect(adapter.descriptor.defaultTransport).toBe("cli");
    expect(adapter.descriptor.capabilities.supportsModelDiscovery).toBe(true);
    expect(adapter.descriptor.capabilities.supportsCustomEndpoint).toBe(true);
    expect(adapter.descriptor.capabilities.supportsAgentDefinitions).toBe(false);
  });

  it("runs via CLI transport by default", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.run(createRunInput());
    expect(result.outputText).toBe("cli-output");
    expect(runCodexCliMock).toHaveBeenCalledTimes(1);
    expect(runCodexAgentApiMock).not.toHaveBeenCalled();
  });

  it("runs via AgentAPI when transport is agentapi", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.run(
      createRunInput({
        transport: "agentapi",
      }),
    );
    expect(result.outputText).toBe("agentapi-output");
    expect(runCodexAgentApiMock).toHaveBeenCalledTimes(1);
    expect(runCodexCliMock).not.toHaveBeenCalled();
  });

  it("resumes sessions using selected transport", async () => {
    const adapter = createCodexRuntimeAdapter();
    await adapter.resume!(
      createRunInput({
        sessionId: "resume-1",
        options: { transport: "agentapi" },
      }) as any,
    );
    expect(runCodexAgentApiMock).toHaveBeenCalledTimes(1);
    const callInput = runCodexAgentApiMock.mock.calls[0][0] as { resume?: boolean };
    expect(callInput.resume).toBe(true);
  });

  it("validates connection via AgentAPI validation when transport is agentapi", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "agentapi",
      options: { agentApiBaseUrl: "http://localhost:8080" },
    });
    expect(result.ok).toBe(true);
    expect(validateCodexAgentApiConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("returns built-in model list", async () => {
    const adapter = createCodexRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });
    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"]);
  });
});
