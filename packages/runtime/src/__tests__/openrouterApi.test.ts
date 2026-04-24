import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listOpenRouterApiModels,
  runOpenRouterApi,
  runOpenRouterApiStreaming,
  validateOpenRouterApiConnection,
} from "../adapters/openrouter/api.js";
import { OpenRouterRuntimeAdapterError } from "../adapters/openrouter/errors.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "openrouter",
    providerId: "openrouter",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "anthropic/claude-sonnet-4",
    options: {},
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenRouter API transport", () => {
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

  // --- runOpenRouterApi ---

  describe("runOpenRouterApi", () => {
    it("sends chat completion request and returns parsed response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: "gen-123",
          choices: [{ message: { content: "Hello world" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );

      const result = await runOpenRouterApi(
        createRunInput({
          options: { apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api/v1" },
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(init.method).toBe("POST");

      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-or-test");
      expect(headers.get("x-title")).toBe("AIF Handoff");

      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.model).toBe("anthropic/claude-sonnet-4");
      expect(body.stream).toBe(false);

      expect(result.outputText).toBe("Hello world");
      expect(result.sessionId).toBe("gen-123");
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: undefined,
      });
    });

    it("includes system prompt when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
        }),
      );

      await runOpenRouterApi(
        createRunInput({
          systemPrompt: "You are a helpful assistant",
          options: { apiKey: "sk-test" },
        }),
      );

      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
      ) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant",
      });
      expect(body.messages[1]).toEqual({
        role: "user",
        content: "Implement feature",
      });
    });

    it("uses default base URL when none provided", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

      await runOpenRouterApi(createRunInput({ options: { apiKey: "sk-test" } }));

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    });

    it("uses OPENROUTER_BASE_URL from env", async () => {
      vi.stubEnv("OPENROUTER_BASE_URL", "https://custom.proxy/v1");
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

      await runOpenRouterApi(createRunInput({ options: { apiKey: "sk-test" } }));

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://custom.proxy/v1/chat/completions");
    });

    it("sets HTTP-Referer and X-Title headers", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

      await runOpenRouterApi(
        createRunInput({
          options: {
            apiKey: "sk-test",
            httpReferer: "https://my-app.com",
            appTitle: "My App",
          },
        }),
      );

      const headers = new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers);
      expect(headers.get("http-referer")).toBe("https://my-app.com");
      expect(headers.get("x-title")).toBe("My App");
    });

    it("throws classified error on HTTP failure", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

      await expect(
        runOpenRouterApi(createRunInput({ options: { apiKey: "bad-key" } })),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
    });

    it("redacts raw provider secrets from non-OK error messages", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"error":"Bearer SECRET sk-SECRET"}', { status: 500 }),
      );

      try {
        await runOpenRouterApi(createRunInput({ options: { apiKey: "bad-key" } }));
      } catch (error) {
        expect(error).toMatchObject({
          message: expect.stringContaining("[REDACTED]"),
        });
        expect(String(error)).not.toContain("SECRET");
        return;
      }

      throw new Error("Expected runOpenRouterApi to throw");
    });

    it("throws timeout error when run exceeds runTimeoutMs", async () => {
      fetchMock.mockRejectedValueOnce(
        new DOMException("The operation was aborted", "TimeoutError"),
      );

      await expect(
        runOpenRouterApi(
          createRunInput({
            options: { apiKey: "sk-test" },
            execution: { runTimeoutMs: 100 },
          }),
        ),
      ).rejects.toMatchObject({
        name: "RuntimeExecutionError",
        category: "timeout",
        message: expect.stringContaining("Run timeout"),
      });
    });

    it("passes run timeout signal to fetch when runTimeoutMs is set", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

      await runOpenRouterApi(
        createRunInput({
          options: { apiKey: "sk-test" },
          execution: { runTimeoutMs: 30_000 },
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns empty output when choices array is empty", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [], usage: {} }));

      const result = await runOpenRouterApi(createRunInput({ options: { apiKey: "sk-test" } }));
      expect(result.outputText).toBe("");
    });

    it("retries on HTTP 429 and succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ choices: [{ message: { content: "ok-after-retry" } }] }),
        );

      const result = await runOpenRouterApi(createRunInput({ options: { apiKey: "sk-test" } }));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.outputText).toBe("ok-after-retry");
    });

    it("fails after max 429 retries", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("r1", { status: 429, headers: { "Retry-After": "0" } }))
        .mockResolvedValueOnce(new Response("r2", { status: 429, headers: { "Retry-After": "0" } }))
        .mockResolvedValueOnce(
          new Response("r3", { status: 429, headers: { "Retry-After": "0" } }),
        );

      await expect(
        runOpenRouterApi(createRunInput({ options: { apiKey: "sk-test" } })),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // --- runOpenRouterApiStreaming ---

  describe("runOpenRouterApiStreaming", () => {
    it("parses SSE stream and accumulates output", async () => {
      const events: unknown[] = [];
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          'data: {"id":"gen-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"id":"gen-1","choices":[{"delta":{"content":" world"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

      const result = await runOpenRouterApiStreaming(
        createRunInput({
          options: { apiKey: "sk-test" },
          execution: {
            onEvent: (event: unknown) => events.push(event),
          },
        }),
      );

      expect(result.outputText).toBe("Hello world");
      expect(result.sessionId).toBe("gen-1");
      expect(events.length).toBe(2);
    });

    it("throws on non-OK streaming response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Rate limit exceeded", { status: 429 }));

      await expect(
        runOpenRouterApiStreaming(createRunInput({ options: { apiKey: "sk-test" } })),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
    });

    it("extracts usage from final SSE chunk", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          'data: {"id":"gen-1","choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

      const result = await runOpenRouterApiStreaming(
        createRunInput({ options: { apiKey: "sk-test" } }),
      );

      expect(result.usage).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        costUsd: undefined,
      });
    });

    it("retries 429 in streaming mode and then succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response("Rate limit exceeded", { status: 429, headers: { "Retry-After": "0" } }),
        )
        .mockResolvedValueOnce(
          sseResponse([
            'data: {"id":"gen-2","choices":[{"delta":{"content":"retry"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        );

      const result = await runOpenRouterApiStreaming(
        createRunInput({ options: { apiKey: "sk-test" } }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.outputText).toBe("retry");
    });

    it("clears start timer when first chunk arrives before startTimeoutMs", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          'data: {"id":"gen-1","choices":[{"delta":{"content":"quick"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

      const result = await runOpenRouterApiStreaming(
        createRunInput({
          options: { apiKey: "sk-test" },
          execution: { startTimeoutMs: 60_000, runTimeoutMs: 120_000 },
        }),
      );

      expect(result.outputText).toBe("quick");
    });

    it("throws timeout error when streaming run exceeds runTimeoutMs", async () => {
      fetchMock.mockRejectedValueOnce(
        new DOMException("The operation was aborted", "TimeoutError"),
      );

      await expect(
        runOpenRouterApiStreaming(
          createRunInput({
            options: { apiKey: "sk-test" },
            execution: { runTimeoutMs: 100 },
          }),
        ),
      ).rejects.toMatchObject({
        name: "RuntimeExecutionError",
        category: "timeout",
        message: expect.stringContaining("Run timeout"),
      });
    });

    it("ignores malformed SSE chunks and continues", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          "data: {not-json}\n\n",
          'data: {"id":"gen-3","choices":[{"delta":{"content":"ok"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

      const logger = { debug: vi.fn() };
      const result = await runOpenRouterApiStreaming(
        createRunInput({ options: { apiKey: "sk-test" } }),
        logger,
      );

      expect(result.outputText).toBe("ok");
      expect(logger.debug).toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          rawLine: "data: {not-json}",
        }),
        "Failed to parse SSE chunk, skipping",
      );
    });
  });

  // --- validateOpenRouterApiConnection ---

  describe("validateOpenRouterApiConnection", () => {
    it("returns ok on successful models endpoint", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const result = await validateOpenRouterApiConnection({
        runtimeId: "openrouter",
        options: { apiKey: "sk-test" },
      });

      expect(result.ok).toBe(true);
    });

    it("returns not ok on HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));

      const result = await validateOpenRouterApiConnection({
        runtimeId: "openrouter",
        options: { apiKey: "sk-test" },
      });

      expect(result.ok).toBe(false);
    });

    it("throws classified error on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));

      await expect(
        validateOpenRouterApiConnection({
          runtimeId: "openrouter",
          options: { apiKey: "sk-test" },
        }),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
    });
  });

  // --- listOpenRouterApiModels ---

  describe("listOpenRouterApiModels", () => {
    it("returns parsed model list", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "anthropic/claude-sonnet-4",
              name: "Claude Sonnet 4",
              context_length: 200000,
              pricing: { prompt: "0.003", completion: "0.015" },
            },
            {
              id: "openai/gpt-4o",
              name: "GPT-4o",
            },
          ],
        }),
      );

      const models = await listOpenRouterApiModels({
        runtimeId: "openrouter",
        options: { apiKey: "sk-test" },
      });

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("anthropic/claude-sonnet-4");
      expect(models[0].label).toBe("Claude Sonnet 4");
      expect(models[0].supportsStreaming).toBe(true);
      expect(models[0].metadata).toEqual({
        contextLength: 200000,
        pricing: { prompt: "0.003", completion: "0.015" },
      });
    });

    it("returns empty array when data is missing", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      const models = await listOpenRouterApiModels({
        runtimeId: "openrouter",
        options: { apiKey: "sk-test" },
      });

      expect(models).toHaveLength(0);
    });

    it("throws classified error on HTTP failure", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));

      await expect(
        listOpenRouterApiModels({
          runtimeId: "openrouter",
          options: { apiKey: "sk-test" },
        }),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
    });

    it("redacts raw provider secrets from model listing failures", async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"error":"Bearer SECRET"}', { status: 500 }));

      await expect(
        listOpenRouterApiModels({
          runtimeId: "openrouter",
          options: { apiKey: "sk-test" },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("[REDACTED]"),
      });
    });

    it("throws classified error on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));

      await expect(
        listOpenRouterApiModels({
          runtimeId: "openrouter",
          options: { apiKey: "sk-test" },
        }),
      ).rejects.toBeInstanceOf(OpenRouterRuntimeAdapterError);
    });
  });
});
