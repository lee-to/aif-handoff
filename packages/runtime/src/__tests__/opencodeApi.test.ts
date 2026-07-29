import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOpenCodeSession,
  listOpenCodeApiModels,
  listOpenCodeSessionEvents,
  listOpenCodeSessions,
  runOpenCodeApi,
  validateOpenCodeApiConnection,
} from "../adapters/opencode/api.js";
import { OpenCodeRuntimeAdapterError } from "../adapters/opencode/errors.js";
import { validateRuntimeModelEffort } from "../modelEffort.js";
import type { RuntimeRunInput } from "../types.js";
import { resetEnvCache } from "@aif/shared";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

function clearProxyEnv() {
  vi.stubEnv("HTTP_PROXY", undefined);
  vi.stubEnv("HTTPS_PROXY", undefined);
  vi.stubEnv("ALL_PROXY", undefined);
  vi.stubEnv("NO_PROXY", undefined);
  vi.stubEnv("http_proxy", undefined);
  vi.stubEnv("https_proxy", undefined);
  vi.stubEnv("all_proxy", undefined);
  vi.stubEnv("no_proxy", undefined);
}

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCode API transport", () => {
  const fetchMock = vi.fn();

  function requestInitAt(index: number): RequestInit & { dispatcher?: unknown } {
    return (fetchMock.mock.calls[index] ?? [])[1] as RequestInit & { dispatcher?: unknown };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.unstubAllEnvs();
    clearProxyEnv();
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("creates session, posts message, and returns output without long-running dispatcher by default", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-1",
          title: "title",
          time: { created: 1710000000, updated: 1710000001 },
          version: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-1", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "Hello from OpenCode" }],
        }),
      );

    const events: unknown[] = [];
    const result = await runOpenCodeApi(
      createRunInput({
        execution: {
          onEvent: (event: unknown) => events.push(event),
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[0] as string).endsWith("/session")).toBe(true);
    expect((fetchMock.mock.calls[1]?.[0] as string).endsWith("/session/session-1/message")).toBe(
      true,
    );
    expect(requestInitAt(0).dispatcher).toBeUndefined();
    expect(requestInitAt(1).dispatcher).toBeUndefined();

    const postBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      model: { providerID: string; modelID: string };
      parts: Array<{ type: string; text: string }>;
    };
    expect(postBody.model.providerID).toBe("anthropic");
    expect(postBody.model.modelID).toBe("claude-sonnet-4");
    expect(postBody.parts[0]).toEqual({ type: "text", text: "Implement feature" });

    expect(result.outputText).toBe("Hello from OpenCode");
    expect(result.sessionId).toBe("session-1");
    expect(events).toHaveLength(1);
  });

  it("passes provider-advertised reasoning effort in the session message", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-effort",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-effort", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "ok" }],
        }),
      );

    const validation = validateRuntimeModelEffort(
      createRunInput({ options: { reasoningEffort: " Max " } }) as RuntimeRunInput,
      [
        {
          id: "anthropic/claude-sonnet-4",
          metadata: {
            supportsEffort: true,
            supportedEffortLevels: ["max"],
          },
        },
      ],
    );
    await runOpenCodeApi(validation.input);

    const postBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      reasoningEffort?: string;
    };
    expect(postBody.reasoningEffort).toBe("max");
  });

  it("does not pass a stale reasoning effort in the session message", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-effort",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-effort", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "ok" }],
        }),
      );

    await runOpenCodeApi(createRunInput({ options: { reasoningEffort: "bogus" } }));

    const postBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      reasoningEffort?: string;
    };
    expect(postBody.reasoningEffort).toBeUndefined();
  });

  it("uses long-running dispatcher for session messages when feature flag is enabled", async () => {
    vi.stubEnv("AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED", "true");
    resetEnvCache();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-flag",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-flag", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "flagged" }],
        }),
      );

    await runOpenCodeApi(createRunInput());

    expect(requestInitAt(0).dispatcher).toBeUndefined();
    expect(requestInitAt(1).dispatcher).toBeDefined();
  });

  it("uses proxy dispatcher for all API requests when proxy env is set", async () => {
    vi.stubEnv("ALL_PROXY", "socks5://proxy.example:1080");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-proxy",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-proxy", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "proxied" }],
        }),
      );

    await runOpenCodeApi(createRunInput());

    expect(requestInitAt(0).dispatcher).toBeDefined();
    expect(requestInitAt(1).dispatcher).toBeDefined();
  });

  it("keeps long-running dispatcher settings when session messages use a proxy", async () => {
    vi.stubEnv("AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED", "true");
    vi.stubEnv("ALL_PROXY", "http://proxy.example:8080");
    resetEnvCache();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-proxy-flag",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-proxy-flag", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "proxied and flagged" }],
        }),
      );

    await runOpenCodeApi(createRunInput());

    expect(requestInitAt(0).dispatcher).toBeDefined();
    expect(requestInitAt(1).dispatcher).toBeDefined();
    expect(requestInitAt(1).dispatcher).not.toBe(requestInitAt(0).dispatcher);
  });

  it("uses existing session when sessionId is provided", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-existing",
          title: "Existing",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-2", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "ok" }],
        }),
      );

    const result = await runOpenCodeApi(
      createRunInput({
        sessionId: "session-existing",
        options: {
          baseUrl: "http://127.0.0.1:60661",
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:60661/session/session-existing");
    expect((fetchMock.mock.calls[0]?.[0] as string).endsWith("/session/session-existing")).toBe(
      true,
    );
    expect(result.sessionId).toBe("session-existing");
  });

  it("creates a new session when provided sessionId does not exist", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-new",
          title: "New",
          time: { created: 1710000100, updated: 1710000101 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-3", role: "assistant", time: 1710000102 },
          parts: [{ type: "text", text: "created from fallback" }],
        }),
      );

    const result = await runOpenCodeApi(
      createRunInput({
        sessionId: "missing-session",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[1]?.[0] as string).endsWith("/session")).toBe(true);
    expect(result.sessionId).toBe("session-new");
  });

  it("adds basic auth header when server password is configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ healthy: true, version: "0.1.0" }));

    const result = await validateOpenCodeApiConnection({
      runtimeId: "opencode",
      options: {
        serverUsername: "opencode",
        serverPassword: "secret",
      },
    });

    expect(result.ok).toBe(true);
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("authorization")?.startsWith("Basic ")).toBe(true);
  });

  it("returns not ok when health endpoint reports unhealthy", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ healthy: false, version: "0.1.0" }));

    const result = await validateOpenCodeApiConnection({
      runtimeId: "opencode",
      options: {},
    });

    expect(result.ok).toBe(false);
  });

  it("lists models from /config/providers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providers: [
          {
            id: "anthropic",
            models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }, "claude-haiku-3-5"],
          },
        ],
      }),
    );

    const models = await listOpenCodeApiModels({ runtimeId: "opencode" });

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("anthropic/claude-sonnet-4");
    expect(models[1].id).toBe("anthropic/claude-haiku-3-5");
  });

  it("maps OpenCode model variants to supported effort levels", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providers: [
          {
            id: "openai",
            models: {
              "gpt-current": {
                name: "GPT Current",
                capabilities: { reasoning: true },
                variants: {
                  low: { reasoningEffort: "low" },
                  max: { reasoningEffort: "max" },
                  duplicate: { reasoningEffort: " low " },
                  empty: { reasoningEffort: "" },
                  disabled: { reasoningEffort: "ultra", disabled: true },
                },
              },
            },
          },
        ],
      }),
    );

    const models = await listOpenCodeApiModels({ runtimeId: "opencode" });

    expect(models).toEqual([
      {
        id: "openai/gpt-current",
        label: "GPT Current",
        supportsStreaming: true,
        metadata: {
          providerID: "openai",
          modelID: "gpt-current",
          supportsEffort: true,
          supportedEffortLevels: ["low", "max"],
        },
      },
    ]);
  });

  it("lists sessions and maps fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "session-1",
          title: "Session One",
          time: { created: 1710000000, updated: 1710001111 },
          version: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        },
      ]),
    );

    const sessions = await listOpenCodeSessions({ runtimeId: "opencode", profileId: "p1" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-1");
    expect(sessions[0].model).toBe("claude-sonnet-4");
    expect(sessions[0].providerId).toBe("anthropic");
  });

  it("respects list session limit", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: "s1", time: { created: 1710000000, updated: 1710000000 } },
        { id: "s2", time: { created: 1710000001, updated: 1710000001 } },
      ]),
    );

    const sessions = await listOpenCodeSessions({
      runtimeId: "opencode",
      profileId: "p1",
      limit: 1,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
  });

  it("returns null on get session 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const session = await getOpenCodeSession({ runtimeId: "opencode", sessionId: "missing" });

    expect(session).toBeNull();
  });

  it("maps session events from message list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          info: { id: "m1", role: "user", time: 1710000000 },
          parts: [{ type: "text", text: "User message" }],
        },
        {
          info: { id: "m2", role: "assistant", time: 1710000001 },
          parts: [{ type: "text", text: "Assistant response" }],
        },
      ]),
    );

    const events = await listOpenCodeSessionEvents({
      runtimeId: "opencode",
      sessionId: "session-1",
      limit: 20,
    });

    expect(events).toHaveLength(2);
    expect(events[0].message).toBe("User message");
    expect(events[1].message).toBe("Assistant response");
  });

  it("skips empty session event parts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          info: { id: "m-empty", role: "assistant", time: 1710000000 },
          parts: [{ type: "tool_use", content: "" }],
        },
      ]),
    );

    const events = await listOpenCodeSessionEvents({
      runtimeId: "opencode",
      sessionId: "session-1",
    });

    expect(events).toHaveLength(0);
  });

  it("includes outputFormat and appended system prompt when provided", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-2",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-4", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: '{"ok":true}' }],
        }),
      );

    await runOpenCodeApi(
      createRunInput({
        model: "gpt-5.4",
        systemPrompt: "base system",
        options: { defaultProviderID: "openai" },
        execution: {
          systemPromptAppend: "extra instructions",
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      }),
    );

    const postBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      model: { providerID: string; modelID: string };
      outputFormat: { type: string };
      system: string;
    };

    expect(postBody.model.providerID).toBe("openai");
    expect(postBody.model.modelID).toBe("gpt-5.4");
    expect(postBody.outputFormat.type).toBe("json_schema");
    expect(postBody.system).toContain("base system");
    expect(postBody.system).toContain("extra instructions");
  });

  it("throws classified error on run failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(runOpenCodeApi(createRunInput())).rejects.toBeInstanceOf(
      OpenCodeRuntimeAdapterError,
    );
  });

  it("redacts raw provider secrets from run failure responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"Bearer SECRET sk-SECRET"}', { status: 500 }),
    );

    try {
      await runOpenCodeApi(createRunInput());
    } catch (error) {
      expect(error).toMatchObject({
        message: expect.stringContaining("[REDACTED]"),
      });
      expect(String(error)).not.toContain("SECRET");
      return;
    }

    throw new Error("Expected runOpenCodeApi to throw");
  });

  it("keeps full model tail when model id contains multiple slashes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-3",
          time: { created: 1710000000, updated: 1710000001 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: { id: "message-5", role: "assistant", time: 1710000002 },
          parts: [{ type: "text", text: "ok" }],
        }),
      );

    await runOpenCodeApi(
      createRunInput({
        model: "openrouter/anthropic/claude-sonnet-4.6",
      }),
    );

    const postBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      model: { providerID: string; modelID: string };
    };

    expect(postBody.model.providerID).toBe("openrouter");
    expect(postBody.model.modelID).toBe("anthropic/claude-sonnet-4.6");
  });
});
