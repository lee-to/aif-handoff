import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeRuntimeAdapterError } from "../adapters/opencode/errors.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

const runOpenCodeApiMock = vi.fn();
const listOpenCodeSessionsMock = vi.fn();
const getOpenCodeSessionMock = vi.fn();
const listOpenCodeSessionEventsMock = vi.fn();
const validateOpenCodeApiConnectionMock = vi.fn();
const listOpenCodeApiModelsMock = vi.fn();

vi.mock("../adapters/opencode/api.js", () => ({
  runOpenCodeApi: (...args: unknown[]) => runOpenCodeApiMock(...args),
  listOpenCodeSessions: (...args: unknown[]) => listOpenCodeSessionsMock(...args),
  getOpenCodeSession: (...args: unknown[]) => getOpenCodeSessionMock(...args),
  listOpenCodeSessionEvents: (...args: unknown[]) => listOpenCodeSessionEventsMock(...args),
  validateOpenCodeApiConnection: (...args: unknown[]) => validateOpenCodeApiConnectionMock(...args),
  listOpenCodeApiModels: (...args: unknown[]) => listOpenCodeApiModelsMock(...args),
}));

const { createOpenCodeRuntimeAdapter } = await import("../adapters/opencode/index.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "opencode",
    providerId: "opencode",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "anthropic/claude-sonnet-4",
    options: {},
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

describe("OpenCode runtime adapter", () => {
  beforeEach(() => {
    runOpenCodeApiMock.mockReset();
    listOpenCodeSessionsMock.mockReset();
    getOpenCodeSessionMock.mockReset();
    listOpenCodeSessionEventsMock.mockReset();
    validateOpenCodeApiConnectionMock.mockReset();
    listOpenCodeApiModelsMock.mockReset();

    runOpenCodeApiMock.mockResolvedValue({ outputText: "api-output", sessionId: "session-1" });
    listOpenCodeSessionsMock.mockResolvedValue([]);
    getOpenCodeSessionMock.mockResolvedValue(null);
    listOpenCodeSessionEventsMock.mockResolvedValue([]);
    validateOpenCodeApiConnectionMock.mockResolvedValue({ ok: true, message: "ok" });
    listOpenCodeApiModelsMock.mockResolvedValue([
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", supportsStreaming: true },
    ]);
  });

  it("exposes opencode descriptor and capabilities", () => {
    const adapter = createOpenCodeRuntimeAdapter();
    expect(adapter.descriptor.id).toBe("opencode");
    expect(adapter.descriptor.providerId).toBe("opencode");
    expect(adapter.descriptor.displayName).toBe("OpenCode");
    expect(adapter.descriptor.defaultTransport).toBe("api");
    expect(adapter.descriptor.defaultBaseUrlEnvVar).toBe("OPENCODE_BASE_URL");
    expect(adapter.descriptor.supportedTransports).toEqual(["api"]);

    const caps = adapter.descriptor.capabilities;
    expect(caps.supportsResume).toBe(true);
    expect(caps.supportsSessionList).toBe(true);
    expect(caps.supportsAgentDefinitions).toBe(false);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsModelDiscovery).toBe(true);
    expect(caps.supportsApprovals).toBe(false);
    expect(caps.supportsCustomEndpoint).toBe(true);
  });

  it("runs api transport", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const result = await adapter.run(createRunInput());

    expect(result.outputText).toBe("api-output");
    expect(runOpenCodeApiMock).toHaveBeenCalledTimes(1);
    const arg = runOpenCodeApiMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.transport).toBe("api");
  });

  it("resumes with explicit session", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    await adapter.resume!({
      ...createRunInput(),
      sessionId: "session-abc",
    });

    const arg = runOpenCodeApiMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.resume).toBe(true);
    expect(arg.transport).toBe("api");
  });

  it("wraps run errors", async () => {
    runOpenCodeApiMock.mockRejectedValueOnce(new Error("Unauthorized"));
    const adapter = createOpenCodeRuntimeAdapter();

    await expect(adapter.run(createRunInput())).rejects.toBeInstanceOf(OpenCodeRuntimeAdapterError);
  });

  it("proxies session methods", async () => {
    const adapter = createOpenCodeRuntimeAdapter();

    await adapter.listSessions!({ runtimeId: "opencode", profileId: "p1", limit: 20 });
    await adapter.getSession!({ runtimeId: "opencode", profileId: "p1", sessionId: "s1" });
    await adapter.listSessionEvents!({ runtimeId: "opencode", profileId: "p1", sessionId: "s1" });

    expect(listOpenCodeSessionsMock).toHaveBeenCalledTimes(1);
    expect(getOpenCodeSessionMock).toHaveBeenCalledTimes(1);
    expect(listOpenCodeSessionEventsMock).toHaveBeenCalledTimes(1);
  });

  it("validates connection via api transport", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const result = await adapter.validateConnection!({ runtimeId: "opencode", options: {} });

    expect(result.ok).toBe(true);
    const arg = validateOpenCodeApiConnectionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.transport).toBe("api");
  });

  it("returns discovered models", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const models = await adapter.listModels!({ runtimeId: "opencode" });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("anthropic/claude-sonnet-4");
  });

  it("falls back to built-in models when discovery fails", async () => {
    listOpenCodeApiModelsMock.mockRejectedValueOnce(new Error("network error"));

    const adapter = createOpenCodeRuntimeAdapter();
    const models = await adapter.listModels!({ runtimeId: "opencode" });

    expect(models.some((model) => model.id === "openai/gpt-5.4")).toBe(true);
  });

  it("diagnoses auth failures", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({ error: new Error("401 unauthorized") });

    expect(message).toContain("OPENCODE_SERVER_PASSWORD");
  });

  it("diagnoses rate limit failures", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({ error: new Error("429 rate limit") });

    expect(message).toContain("rate-limited");
  });

  it("diagnoses timeout failures", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({ error: new Error("request timed out") });

    expect(message).toContain("timed out");
  });

  it("diagnoses network failures", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({ error: new Error("connection refused") });

    expect(message).toContain("Cannot reach OpenCode server");
  });

  it("diagnoses missing session", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({ error: new Error("session not found") });

    expect(message).toContain("session not found");
  });

  it("diagnoses provider/model mismatch", async () => {
    const adapter = createOpenCodeRuntimeAdapter();
    const message = await adapter.diagnoseError!({
      error: new Error("ProviderModelNotFoundError: provider not found"),
    });

    expect(message).toContain("GET /config/providers");
  });
});
