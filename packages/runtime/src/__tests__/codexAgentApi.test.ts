import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCodexAgentApiModels,
  runCodexAgentApi,
  runCodexAgentApiStreaming,
  validateCodexAgentApiConnection,
} from "../adapters/codex/api.js";
import { CodexRuntimeAdapterError } from "../adapters/codex/errors.js";

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "gpt-4o",
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

describe("codex api transport (OpenAI Chat Completions)", () => {
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

  it("sends chat completions request and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "chatcmpl-123",
        choices: [{ message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    );

    const result = await runCodexAgentApi(
      createRunInput({
        options: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          headers: { "X-Trace-Id": "trace-1" },
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("x-trace-id")).toBe("trace-1");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "Implement feature" }]);
    expect(body.stream).toBe(false);

    expect(result.outputText).toBe("done");
    expect(result.sessionId).toBe("chatcmpl-123");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      costUsd: undefined,
    });
  });

  it("includes system prompt in messages", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "chatcmpl-456",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    );

    await runCodexAgentApi(
      createRunInput({
        systemPrompt: "You are a planner",
        options: { baseUrl: "https://api.openai.com/v1" },
      }),
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([
      { role: "system", content: "You are a planner" },
      { role: "user", content: "Implement feature" },
    ]);
  });

  it("throws classified error for non-ok responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid key", { status: 401 }));

    await expect(
      runCodexAgentApi(
        createRunInput({
          options: { baseUrl: "https://api.openai.com/v1" },
        }),
      ),
    ).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_AUTH_ERROR",
    });
  });

  it("retries non-stream request on retryable 5xx response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "chatcmpl-retry",
          choices: [{ message: { role: "assistant", content: "recovered" } }],
        }),
      );

    const result = await runCodexAgentApi(
      createRunInput({
        options: { baseUrl: "https://api.openai.com/v1", apiRetryCount: 2 },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.outputText).toBe("recovered");
  });

  it("validates connection via /models endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(result).toEqual({ ok: true, message: "OpenAI API connection validated" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
  });

  it("returns ok=false for non-ok health response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));

    const result = await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("503");
  });

  it("throws classified error for health-check network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(
      validateCodexAgentApiConnection({
        runtimeId: "codex",
        providerId: "openai",
        options: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).rejects.toBeInstanceOf(CodexRuntimeAdapterError);
  });

  it("lists models from OpenAI data payload", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "gpt-4o", owned_by: "openai" },
          { id: "gpt-4o-mini", owned_by: "openai" },
        ],
      }),
    );

    const models = await listCodexAgentApiModels({
      runtimeId: "codex",
      providerId: "openai",
      options: { baseUrl: "https://api.openai.com/v1" },
    });

    expect(models).toEqual([
      { id: "gpt-4o", label: "gpt-4o", supportsStreaming: true, metadata: { owned_by: "openai" } },
      {
        id: "gpt-4o-mini",
        label: "gpt-4o-mini",
        supportsStreaming: true,
        metadata: { owned_by: "openai" },
      },
    ]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
  });

  it("uses top-level baseUrl, apiKeyEnvVar, apiKey, and headers for model listing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "gpt-4o", owned_by: "openai" }],
      }),
    );

    await listCodexAgentApiModels({
      runtimeId: "codex",
      providerId: "openai",
      baseUrl: "https://runtime.example.com/v1",
      apiKeyEnvVar: "RUNTIME_API_KEY",
      apiKey: "sk-top-level",
      headers: { "X-Trace-Id": "trace-top-level" },
      options: {},
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://runtime.example.com/v1/models");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-top-level");
    expect(headers.get("x-trace-id")).toBe("trace-top-level");
  });

  it("throws classified error when model listing returns non-ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));

    await expect(
      listCodexAgentApiModels({
        runtimeId: "codex",
        providerId: "openai",
        options: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).rejects.toBeInstanceOf(CodexRuntimeAdapterError);
  });

  it("throws classified error when model listing has network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(
      listCodexAgentApiModels({
        runtimeId: "codex",
        providerId: "openai",
        options: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).rejects.toBeInstanceOf(CodexRuntimeAdapterError);
  });

  it("uses env fallback for base url and API key", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("OPENAI_API_KEY", "env-key");
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: {},
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
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

  it("streaming collects text deltas and returns full output", async () => {
    const sseBody = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"}}]}',
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const events: Array<{ type: string; message?: string }> = [];
    const result = await runCodexAgentApiStreaming(
      createRunInput({
        options: { baseUrl: "https://api.openai.com/v1" },
        execution: {
          onEvent: (e: { type: string; message?: string }) => events.push(e),
        },
      }),
    );

    expect(result.outputText).toBe("Hello world");
    expect(result.sessionId).toBe("chatcmpl-1");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      costUsd: undefined,
    });
    expect(events).toHaveLength(2);
    expect(events[0].message).toBe("Hello");
    expect(events[1].message).toBe(" world");
  });

  it("retries streaming request on retryable 5xx response", async () => {
    const sseBody = [
      'data: {"id":"chatcmpl-2","choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response("temporary failure", { status: 502 }))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const result = await runCodexAgentApiStreaming(
      createRunInput({
        options: { baseUrl: "https://api.openai.com/v1", apiRetryCount: 2 },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.outputText).toBe("ok");
  });
});
