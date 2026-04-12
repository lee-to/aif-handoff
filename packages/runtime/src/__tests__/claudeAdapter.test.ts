import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

const queryMock = vi.fn();
const listSessionsMock = vi.fn();
const getSessionInfoMock = vi.fn();
const getSessionMessagesMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  listSessions: listSessionsMock,
  getSessionInfo: getSessionInfoMock,
  getSessionMessages: getSessionMessagesMock,
}));

// Mock the CLI probe so tests don't depend on `claude` being installed
vi.mock("../adapters/claude/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/claude/cli.js")>();
  return {
    ...actual,
    probeClaudeCli: vi.fn(() => ({ ok: true, version: "1.0.0-mock" })),
  };
});

const { createClaudeRuntimeAdapter } = await import("../adapters/claude/index.js");
const { ClaudeRuntimeAdapterError } = await import("../adapters/claude/errors.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "claude",
    providerId: "anthropic",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    options: {
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
    },
    execution: {
      startTimeoutMs: 10,
      startRetryDelayMs: 0,
    },
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

function delayedSuccess(delayMs: number, result: string) {
  return async function* () {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield {
      type: "system",
      subtype: "init",
      session_id: "runtime-session-1",
    };
    yield {
      type: "result",
      subtype: "success",
      result,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      total_cost_usd: 0.12,
    };
  };
}

function immediateSuccess(result: string) {
  return async function* () {
    yield {
      type: "system",
      subtype: "init",
      session_id: "runtime-session-1",
    };
    yield {
      type: "result",
      subtype: "success",
      result,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      total_cost_usd: 0.12,
    };
  };
}

function discoverySession(
  models: Array<{
    value: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: Array<"low" | "medium" | "high" | "max">;
    supportsAdaptiveThinking?: boolean;
    supportsFastMode?: boolean;
    supportsAutoMode?: boolean;
  }>,
) {
  return {
    async supportedModels() {
      return models;
    },
    async return() {
      return { done: true, value: undefined };
    },
    async next() {
      return { done: true, value: undefined };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function hangingDiscoverySession(returnSpy: () => void, closeSpy?: () => void) {
  return {
    async supportedModels() {
      await new Promise<never>(() => {
        // intentionally never resolved
      });
      return [];
    },
    async return() {
      returnSpy();
      return { done: true, value: undefined };
    },
    async next() {
      return { done: true, value: undefined };
    },
    async throw(error?: unknown) {
      throw error;
    },
    close() {
      closeSpy?.();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function failingDiscoverySession(returnSpy: () => void, error: Error) {
  return {
    async supportedModels() {
      throw error;
    },
    async return() {
      returnSpy();
      return { done: true, value: undefined };
    },
    async next() {
      return { done: true, value: undefined };
    },
    async throw(throwError?: unknown) {
      throw throwError;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function missingSessionFailure(sessionId: string) {
  return async function* () {
    yield {
      type: "result",
      subtype: "error_during_execution",
      result: `No conversation found with session ID: ${sessionId}`,
    };
  };
}

function genericExecutionFailure() {
  return async function* () {
    yield {
      type: "result",
      subtype: "error_during_execution",
      result: "Claude query failed: error_during_execution",
    };
  };
}

function missingSessionFailureWithoutResultDetail(sessionId: string) {
  return async function* () {
    yield {
      type: "result",
      subtype: "error_during_execution",
    };
    throw new Error(
      `Claude Code returned an error result: No conversation found with session ID: ${sessionId}`,
    );
  };
}

describe("Claude runtime adapter", () => {
  beforeEach(() => {
    queryMock.mockReset();
    listSessionsMock.mockReset();
    getSessionInfoMock.mockReset();
    getSessionMessagesMock.mockReset();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("supports custom descriptor fields", () => {
    const adapter = createClaudeRuntimeAdapter({
      runtimeId: "claude-custom",
      providerId: "anthropic-compatible",
      displayName: "Claude Custom",
    });

    expect(adapter.descriptor.id).toBe("claude-custom");
    expect(adapter.descriptor.providerId).toBe("anthropic-compatible");
    expect(adapter.descriptor.displayName).toBe("Claude Custom");
    expect(adapter.descriptor.skillCommandPrefix).toBeUndefined();
  });

  it("returns runtime output/session/usage for successful runs", async () => {
    queryMock.mockImplementation(delayedSuccess(0, "done"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.run(createRunInput());
    expect(result.outputText).toBe("done");
    expect(result.sessionId).toBe("runtime-session-1");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.12,
    });
  });

  it("retries once when first message exceeds query_start_timeout", async () => {
    queryMock
      .mockImplementationOnce(delayedSuccess(50, "late-first"))
      .mockImplementationOnce(delayedSuccess(0, "second-attempt-ok"));

    const adapter = createClaudeRuntimeAdapter();
    const result = await adapter.run(createRunInput());

    expect(result.outputText).toBe("second-attempt-ok");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("maps session list/get/events to runtime-neutral structures", async () => {
    listSessionsMock.mockResolvedValueOnce([
      {
        sessionId: "session-1",
        summary: "Summary",
        createdAt: 1704067200000,
        lastModified: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "session-2",
        firstPrompt: "This is a very long first prompt that should be truncated in the title",
        lastModified: "2026-01-02T00:00:00.000Z",
      },
    ]);
    getSessionInfoMock.mockResolvedValueOnce({
      sessionId: "session-1",
      customTitle: "Custom title",
      summary: "Summary",
      lastModified: "2026-01-01T00:00:00.000Z",
    });
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        uuid: "m-1",
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from array payload" }],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        uuid: "m-2",
        type: "system",
        message: "ignore",
      },
      {
        uuid: "m-3",
        type: "assistant",
        message: "",
      },
    ]);

    const adapter = createClaudeRuntimeAdapter();
    const noProjectRoot = await adapter.listSessions!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
    });
    expect(noProjectRoot).toEqual([]);

    const sessions = await adapter.listSessions!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      projectRoot: "/tmp/project",
      limit: 1,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-1");
    expect(typeof sessions[0].createdAt).toBe("string");

    const session = await adapter.getSession!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
    });
    expect(session?.id).toBe("session-1");
    expect(session?.title).toBe("Custom title");

    const events = await adapter.listSessionEvents!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      limit: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("Hello from array payload");
    expect(events[0].data).toEqual({ role: "assistant", id: "m-1" });
  });

  it("returns null from getSession when sdk has no info", async () => {
    getSessionInfoMock.mockResolvedValueOnce(null);
    const adapter = createClaudeRuntimeAdapter();
    const session = await adapter.getSession!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      sessionId: "missing",
      projectRoot: "/tmp/project",
    });
    expect(session).toBeNull();
  });

  it("classifies sdk errors from session apis", async () => {
    listSessionsMock.mockRejectedValueOnce(new Error("permission denied to list sessions"));
    getSessionInfoMock.mockRejectedValueOnce(new Error("usage limit reached"));
    getSessionMessagesMock.mockRejectedValueOnce(new Error("stream interrupted"));

    const adapter = createClaudeRuntimeAdapter();

    await expect(
      adapter.listSessions!({
        runtimeId: "claude",
        providerId: "anthropic",
        profileId: "profile-1",
        projectRoot: "/tmp/project",
      }),
    ).rejects.toMatchObject({
      adapterCode: "CLAUDE_PERMISSION_DENIED",
      name: "ClaudeRuntimeAdapterError",
    });

    await expect(
      adapter.getSession!({
        runtimeId: "claude",
        providerId: "anthropic",
        profileId: "profile-1",
        projectRoot: "/tmp/project",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      adapterCode: "CLAUDE_USAGE_LIMIT",
      name: "ClaudeRuntimeAdapterError",
    });

    await expect(
      adapter.listSessionEvents!({
        runtimeId: "claude",
        providerId: "anthropic",
        profileId: "profile-1",
        projectRoot: "/tmp/project",
        sessionId: "session-1",
      }),
    ).rejects.toBeInstanceOf(ClaudeRuntimeAdapterError);
  });

  it("validates connection with runtime-specific rules", async () => {
    const adapter = createClaudeRuntimeAdapter();

    // SDK transport passes without API key (session auth)
    const sdkNoKey = await adapter.validateConnection!({
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      options: {},
    });
    expect(sdkNoKey.ok).toBe(true);

    const sdkWithKey = await adapter.validateConnection!({
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      options: { apiKey: "  sk-test  " },
    });
    expect(sdkWithKey.ok).toBe(true);

    const cliWithoutKey = await adapter.validateConnection!({
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "cli",
      options: {},
    });
    expect(cliWithoutKey.ok).toBe(true);
  });

  it("lists discovered Claude models from SDK control initialization", async () => {
    queryMock.mockImplementation(() =>
      discoverySession([
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Balanced model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
        },
      ]),
    );
    const adapter = createClaudeRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      transport: "cli",
    });

    expect(models).toEqual([
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        supportsStreaming: true,
        metadata: {
          description: "Balanced model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
        },
      },
    ]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("forwards temporary API key input into Claude model discovery env", async () => {
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");
    queryMock.mockImplementation(() =>
      discoverySession([
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Balanced model",
        },
      ]),
    );
    const adapter = createClaudeRuntimeAdapter();

    await adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      transport: "sdk",
      apiKey: "sk-temp-discovery",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0][0];
    expect(call.options.env.ANTHROPIC_API_KEY).toBe("sk-temp-discovery");
    expect(call.options.env.npm_config_registry).toBeUndefined();
  });

  it("falls back to default Claude models when dynamic discovery fails", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("initialize failed");
    });
    const adapter = createClaudeRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
    });

    expect(models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(models[0]?.metadata).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
    });
    expect(models[1]?.metadata).toMatchObject({
      supportsAdaptiveThinking: true,
      supportedEffortLevels: ["low", "medium", "high"],
    });
  });

  it("falls back to defaults when model discovery times out and still cleans up session", async () => {
    vi.useFakeTimers();
    const returnSpy = vi.fn();
    const closeSpy = vi.fn();
    queryMock.mockImplementation(() => hangingDiscoverySession(returnSpy, closeSpy));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = createClaudeRuntimeAdapter({ logger });

    const modelsPromise = adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      transport: "sdk",
      options: {
        modelDiscoveryTimeoutMs: 10,
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    const models = await modelsPromise;

    expect(models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(returnSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10 }),
      "WARN [runtime:claude] Claude model discovery timed out, falling back to built-in list",
    );
    vi.useRealTimers();
  });

  it("logs unexpected model discovery failures after cleanup and falls back", async () => {
    const returnSpy = vi.fn();
    queryMock.mockImplementation(() =>
      failingDiscoverySession(returnSpy, new Error("sdk discovery failed")),
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = createClaudeRuntimeAdapter({ logger });

    const models = await adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
      transport: "sdk",
      options: {},
    });

    expect(models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(returnSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: "sdk discovery failed" }),
      "ERROR [runtime:claude] Claude model discovery failed after cleanup, falling back to built-in list",
    );
  });

  it("forwards resume mode and session id to Claude query options", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    queryMock.mockImplementation(immediateSuccess("resumed"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        systemPrompt: "Project system prompt",
        model: "claude-sonnet-4-5",
        execution: {
          timeoutMs: 10,
          retryDelayMs: 0,
          systemPromptAppend: "Runtime append",
          includePartialMessages: true,
          maxTurns: 4,
          maxBudgetUsd: 2,
          bypassPermissions: true,
          agentDefinitionName: "implement-coordinator",
          environment: { CUSTOM_ENV: "1" },
          hooks: {
            allowDangerouslySkipPermissions: true,
            _trustToken: Symbol.for("aif.runtime.trust"),
            settingSources: ["project", "user"],
          },
        },
        options: {
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
          baseUrl: "https://api.anthropic.com",
        },
      }),
      sessionId: "session-resume-1",
    });

    expect(result.outputText).toBe("resumed");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0][0];
    expect(call.options.resume).toBe("session-resume-1");
    expect(call.options.systemPrompt.append).toContain("Project system prompt");
    expect(call.options.systemPrompt.append).toContain("Runtime append");
    expect(call.options.model).toBe("claude-sonnet-4-5");
    expect(call.options.includePartialMessages).toBe(true);
    expect(call.options.maxTurns).toBe(4);
    expect(call.options.maxBudgetUsd).toBe(2);
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.extraArgs).toEqual({ agent: "implement-coordinator" });
    expect(call.options.settingSources).toEqual(["project", "user"]);
    expect(call.options.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(call.options.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(call.options.env.CUSTOM_ENV).toBe("1");
  });

  it("forwards effort to Claude query options", async () => {
    queryMock.mockImplementation(immediateSuccess("effort-ok"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.run(
      createRunInput({
        model: "sonnet",
        options: {
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
          effort: "high",
        },
      }),
    );

    expect(result.outputText).toBe("effort-ok");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0][0];
    expect(call.options.model).toBe("sonnet");
    expect(call.options.effort).toBe("high");
  });

  it("maps numeric effort values to supported Claude effort levels", async () => {
    queryMock.mockImplementation(immediateSuccess("effort-mapped"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.run(
      createRunInput({
        model: "sonnet",
        options: {
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
          effort: 3,
        },
      }),
    );

    expect(result.outputText).toBe("effort-mapped");
    const call = queryMock.mock.calls[0][0];
    expect(call.options.model).toBe("sonnet");
    expect(call.options.effort).toBe("high");
  });

  it("drops unsupported effort values instead of passing them through", async () => {
    queryMock.mockImplementation(immediateSuccess("effort-dropped"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.run(
      createRunInput({
        model: "sonnet",
        options: {
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
          effort: 999,
        },
      }),
    );

    expect(result.outputText).toBe("effort-dropped");
    const call = queryMock.mock.calls[0][0];
    expect(call.options.model).toBe("sonnet");
    expect(call.options.effort).toBeUndefined();
  });

  it("retries without resume when the previous session is missing", async () => {
    queryMock
      .mockImplementationOnce(missingSessionFailure("session-resume-missing"))
      .mockImplementationOnce(delayedSuccess(0, "fresh-session-ok"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        execution: {
          timeoutMs: 100,
          retryDelayMs: 0,
        },
      }),
      sessionId: "session-resume-missing",
    });

    expect(result.outputText).toBe("fresh-session-ok");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe("session-resume-missing");
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBeUndefined();
  });

  it("retries without resume when sdk throws missing-session after empty error result", async () => {
    queryMock
      .mockImplementationOnce(missingSessionFailureWithoutResultDetail("session-resume-missing-2"))
      .mockImplementationOnce(delayedSuccess(0, "fresh-session-after-empty-result-error"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        execution: {
          timeoutMs: 100,
          retryDelayMs: 0,
        },
      }),
      sessionId: "session-resume-missing-2",
    });

    expect(result.outputText).toBe("fresh-session-after-empty-result-error");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe("session-resume-missing-2");
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBeUndefined();
  });

  it("retries without resume on generic execution failure during resume", async () => {
    queryMock
      .mockImplementationOnce(genericExecutionFailure())
      .mockImplementationOnce(delayedSuccess(0, "fresh-session-after-generic-failure"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        execution: {
          timeoutMs: 100,
          retryDelayMs: 0,
        },
      }),
      sessionId: "session-resume-generic-failure",
    });

    expect(result.outputText).toBe("fresh-session-after-generic-failure");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe("session-resume-generic-failure");
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBeUndefined();
  });

  it("fails when stream ends with non-success result and sdk does not throw", async () => {
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
      };
    });
    const adapter = createClaudeRuntimeAdapter();

    await expect(adapter.run(createRunInput())).rejects.toMatchObject({
      name: "ClaudeRuntimeAdapterError",
      adapterCode: "CLAUDE_RUNTIME_ERROR",
    });
  });
});
