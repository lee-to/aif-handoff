import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    metadata: {
      queryStartTimeoutMs: 10,
      queryStartRetryDelayMs: 0,
    },
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

  it("lists default Claude models", async () => {
    const adapter = createClaudeRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-1",
    });

    expect(models.map((model) => model.id)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("forwards resume mode and session id to Claude query options", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    queryMock.mockImplementation(immediateSuccess("resumed"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        systemPrompt: "Project system prompt",
        model: "claude-sonnet-4-5",
        metadata: {
          queryStartTimeoutMs: 10,
          queryStartRetryDelayMs: 0,
          systemPromptAppend: "Runtime append",
          includePartialMessages: true,
          maxTurns: 4,
          maxBudgetUsd: 2,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          _trustToken: Symbol.for("aif.runtime.trust"),
          agentDefinitionName: "implement-coordinator",
          settingSources: ["project", "user"],
          environment: { CUSTOM_ENV: "1" },
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

  it("retries without resume when the previous session is missing", async () => {
    queryMock
      .mockImplementationOnce(missingSessionFailure("session-resume-missing"))
      .mockImplementationOnce(delayedSuccess(0, "fresh-session-ok"));
    const adapter = createClaudeRuntimeAdapter();

    const result = await adapter.resume!({
      ...createRunInput({
        metadata: {
          queryStartTimeoutMs: 100,
          queryStartRetryDelayMs: 0,
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
        metadata: {
          queryStartTimeoutMs: 100,
          queryStartRetryDelayMs: 0,
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
        metadata: {
          queryStartTimeoutMs: 100,
          queryStartRetryDelayMs: 0,
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
