import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterRuntimeAdapterError } from "../adapters/openrouter/errors.js";

const runOpenRouterApiMock = vi.fn();
const runOpenRouterApiStreamingMock = vi.fn();
const validateOpenRouterApiConnectionMock = vi.fn();
const listOpenRouterApiModelsMock = vi.fn();

vi.mock("../adapters/openrouter/api.js", () => ({
  runOpenRouterApi: (...args: unknown[]) => runOpenRouterApiMock(...args),
  runOpenRouterApiStreaming: (...args: unknown[]) => runOpenRouterApiStreamingMock(...args),
  validateOpenRouterApiConnection: (...args: unknown[]) =>
    validateOpenRouterApiConnectionMock(...args),
  listOpenRouterApiModels: (...args: unknown[]) => listOpenRouterApiModelsMock(...args),
}));

const { createOpenRouterRuntimeAdapter } = await import("../adapters/openrouter/index.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "openrouter",
    providerId: "openrouter",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "anthropic/claude-sonnet-4",
    options: {},
    ...overrides,
  };
}

describe("OpenRouter runtime adapter", () => {
  beforeEach(() => {
    runOpenRouterApiMock.mockReset();
    runOpenRouterApiStreamingMock.mockReset();
    validateOpenRouterApiConnectionMock.mockReset();
    listOpenRouterApiModelsMock.mockReset();
    runOpenRouterApiMock.mockResolvedValue({ outputText: "api-output", sessionId: "gen-1" });
    runOpenRouterApiStreamingMock.mockResolvedValue({
      outputText: "stream-output",
      sessionId: "gen-2",
    });
    validateOpenRouterApiConnectionMock.mockResolvedValue({ ok: true, message: "ok" });
    listOpenRouterApiModelsMock.mockResolvedValue([
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
    ]);
  });

  // --- Descriptor ---

  it("exposes openrouter descriptor and capabilities", () => {
    const adapter = createOpenRouterRuntimeAdapter();
    expect(adapter.descriptor.id).toBe("openrouter");
    expect(adapter.descriptor.providerId).toBe("openrouter");
    expect(adapter.descriptor.displayName).toBe("OpenRouter");
    expect(adapter.descriptor.defaultTransport).toBe("api");
    expect(adapter.descriptor.defaultApiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expect(adapter.descriptor.lightModel).toBeNull();
    expect(adapter.descriptor.supportedTransports).toEqual(["api"]);
    expect(adapter.descriptor.supportsProjectInit).toBeUndefined();
  });

  it("has correct capabilities", () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const caps = adapter.descriptor.capabilities;
    expect(caps.supportsResume).toBe(false);
    expect(caps.supportsSessionList).toBe(false);
    expect(caps.supportsAgentDefinitions).toBe(false);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsModelDiscovery).toBe(true);
    expect(caps.supportsApprovals).toBe(false);
    expect(caps.supportsCustomEndpoint).toBe(true);
  });

  it("accepts custom runtimeId and providerId", () => {
    const adapter = createOpenRouterRuntimeAdapter({
      runtimeId: "my-openrouter",
      providerId: "custom-provider",
      displayName: "Custom Router",
    });
    expect(adapter.descriptor.id).toBe("my-openrouter");
    expect(adapter.descriptor.providerId).toBe("custom-provider");
    expect(adapter.descriptor.displayName).toBe("Custom Router");
  });

  // --- run() ---

  it("uses non-streaming API by default", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const result = await adapter.run(createRunInput());

    expect(result.outputText).toBe("api-output");
    expect(runOpenRouterApiMock).toHaveBeenCalledTimes(1);
    expect(runOpenRouterApiStreamingMock).not.toHaveBeenCalled();
  });

  it("uses streaming API when onEvent callback is provided", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const result = await adapter.run(
      createRunInput({
        execution: { onEvent: vi.fn() },
      }),
    );

    expect(result.outputText).toBe("stream-output");
    expect(runOpenRouterApiStreamingMock).toHaveBeenCalledTimes(1);
    expect(runOpenRouterApiMock).not.toHaveBeenCalled();
  });

  it("uses non-streaming when stream is explicitly false", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const result = await adapter.run(
      createRunInput({
        stream: false,
        execution: { onEvent: vi.fn() },
      }),
    );

    expect(result.outputText).toBe("api-output");
    expect(runOpenRouterApiMock).toHaveBeenCalledTimes(1);
  });

  it("wraps errors with classifyOpenRouterRuntimeError", async () => {
    runOpenRouterApiMock.mockRejectedValueOnce(new Error("Unauthorized"));
    const adapter = createOpenRouterRuntimeAdapter();

    await expect(adapter.run(createRunInput())).rejects.toBeInstanceOf(
      OpenRouterRuntimeAdapterError,
    );
  });

  // --- validateConnection() ---

  it("validates connection when API key is present", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "openrouter",
      options: { apiKey: "sk-or-test" },
    });

    expect(result.ok).toBe(true);
    expect(validateOpenRouterApiConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("returns not ok when API key is missing", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "openrouter",
      options: {},
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("OPENROUTER_API_KEY");
    expect(validateOpenRouterApiConnectionMock).not.toHaveBeenCalled();
  });

  // --- listModels() ---

  it("returns models from API when available", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "openrouter",
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("anthropic/claude-sonnet-4");
    expect(listOpenRouterApiModelsMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to built-in list when API fails", async () => {
    listOpenRouterApiModelsMock.mockRejectedValueOnce(new Error("network error"));
    const adapter = createOpenRouterRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "openrouter",
    });

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m: { id: string }) => m.id === "anthropic/claude-sonnet-4")).toBe(true);
  });

  it("falls back to built-in list when API returns empty", async () => {
    listOpenRouterApiModelsMock.mockResolvedValueOnce([]);
    const adapter = createOpenRouterRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "openrouter",
    });

    expect(models.length).toBeGreaterThan(0);
  });

  // --- diagnoseError() ---

  it("diagnoses auth errors", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const msg = await adapter.diagnoseError!({
      error: new Error("Unauthorized"),
    });

    expect(msg).toContain("OPENROUTER_API_KEY");
  });

  it("diagnoses rate limit errors", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const msg = await adapter.diagnoseError!({
      error: new Error("429 rate limit"),
    });

    expect(msg).toContain("rate limit");
  });

  it("diagnoses model not found errors", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const msg = await adapter.diagnoseError!({
      error: new Error("model not found"),
    });

    expect(msg).toContain("model");
  });

  it("returns generic message for unknown errors", async () => {
    const adapter = createOpenRouterRuntimeAdapter();
    const msg = await adapter.diagnoseError!({
      error: new Error("something unexpected"),
    });

    expect(msg).toContain("something unexpected");
  });
});
