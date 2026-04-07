import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCodexAgentApiModels,
  runCodexAgentApi,
  validateCodexAgentApiConnection,
} from "../adapters/codex/api.js";

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "gpt-5.4",
    sessionId: "session-1",
    resume: false,
    options: {},
    metadata: {},
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("codex agentapi transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("runs through agentapi transport and normalizes response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        outputText: "done",
        sessionId: "session-2",
        usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.2 },
        events: [{ type: "stream:text", timestamp: "2026-04-04T00:00:00.000Z" }],
      }),
    );

    const result = await runCodexAgentApi(
      createRunInput({
        options: {
          agentApiBaseUrl: "https://agent.example.com/",
          apiKey: "sk-test",
          headers: { "X-Trace-Id": "trace-1" },
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example.com/v1/runtime/run");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("x-trace-id")).toBe("trace-1");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.prompt).toBe("Implement feature");
    expect(body.model).toBe("gpt-5.4");
    expect(body.sessionId).toBe("session-1");

    expect(result.outputText).toBe("done");
    expect(result.sessionId).toBe("session-2");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      costUsd: 0.2,
    });
    expect(result.events).toEqual([{ type: "stream:text", timestamp: "2026-04-04T00:00:00.000Z" }]);
  });

  it("supports custom run path without leading slash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: "ok" }));

    await runCodexAgentApi(
      createRunInput({
        options: {
          agentApiBaseUrl: "https://agent.example.com",
          agentApiRunPath: "custom/run",
        },
      }),
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example.com/custom/run");
  });

  it("throws classified error for non-ok run responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid key", { status: 401 }));

    await expect(
      runCodexAgentApi(
        createRunInput({
          options: { agentApiBaseUrl: "https://agent.example.com" },
        }),
      ),
    ).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_AUTH_ERROR",
    });
  });

  it("validates connection via health endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: { agentApiBaseUrl: "https://agent.example.com" },
    });

    expect(result).toEqual({ ok: true, message: "AgentAPI connection validated" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example.com/v1/runtime/health");
    expect(init.method).toBe("GET");
  });

  it("returns ok=false for non-ok health response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));

    const result = await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: { agentApiBaseUrl: "https://agent.example.com", agentApiValidationPath: "healthz" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("503");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example.com/healthz");
  });

  it("lists models from `models` and `data` payload shapes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          models: [{ id: "gpt-5.4", label: "GPT 5.4", supportsStreaming: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "gpt-5.4-mini", label: "GPT 5.4 Mini", supportsStreaming: true }],
        }),
      );

    const first = await listCodexAgentApiModels({
      runtimeId: "codex",
      providerId: "openai",
      options: { agentApiBaseUrl: "https://agent.example.com" },
    });
    const second = await listCodexAgentApiModels({
      runtimeId: "codex",
      providerId: "openai",
      options: { agentApiBaseUrl: "https://agent.example.com", agentApiModelsPath: "models" },
    });

    expect(first).toEqual([{ id: "gpt-5.4", label: "GPT 5.4", supportsStreaming: true }]);
    expect(second).toEqual([
      { id: "gpt-5.4-mini", label: "GPT 5.4 Mini", supportsStreaming: true },
    ]);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe(
      "https://agent.example.com/models",
    );
  });

  it("uses env fallback for base url and API key", async () => {
    vi.stubEnv("AGENTAPI_BASE_URL", "https://agent.env/");
    vi.stubEnv("OPENAI_API_KEY", "env-key");
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: {},
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.env/v1/runtime/health");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer env-key");
  });

  it("throws when base url cannot be resolved", async () => {
    await expect(
      validateCodexAgentApiConnection({
        runtimeId: "codex",
        providerId: "openai",
        options: {},
      }),
    ).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_RUNTIME_ERROR",
    });
  });
});
