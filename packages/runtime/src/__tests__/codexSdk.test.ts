import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

// Mock the Codex SDK
const mockRunStreamed = vi.fn();
const mockThread = {
  id: "thread-abc123",
  runStreamed: mockRunStreamed,
};
const mockCodexConstructor = vi.fn();
const mockStartThread = vi.fn().mockReturnValue(mockThread);
const mockResumeThread = vi.fn().mockReturnValue(mockThread);
const mockGetCodexSessionLimitSnapshot = vi.fn();

class MockCodex {
  constructor(options: unknown) {
    mockCodexConstructor(options);
  }

  startThread = mockStartThread;
  resumeThread = mockResumeThread;
}

vi.mock("@openai/codex-sdk", () => ({
  Codex: MockCodex,
}));

vi.mock("../adapters/codex/sessions.js", () => ({
  getCodexSessionLimitSnapshot: (...args: unknown[]) => mockGetCodexSessionLimitSnapshot(...args),
}));

const { runCodexSdk } = await import("../adapters/codex/sdk.js");

function createRunInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "codex",
    providerId: "openai",
    prompt: "Implement the feature",
    options: {},
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

async function* createMockEvents(
  events: Array<{ type: string; [key: string]: unknown }>,
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  for (const event of events) {
    yield event;
  }
}

describe("runCodexSdk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockStartThread.mockReturnValue(mockThread);
    mockResumeThread.mockReturnValue(mockThread);
    mockGetCodexSessionLimitSnapshot.mockResolvedValue(null);
  });

  it("starts a new thread and returns output text", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-new" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: "Done implementing" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
        },
      ]),
    });

    const result = await runCodexSdk(createRunInput());

    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).not.toHaveBeenCalled();
    expect(result.outputText).toBe("Done implementing");
    expect(result.sessionId).toBe("thread-new");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("appends a runtime:limit event when the session store exposes Codex quota data", async () => {
    const onEvent = vi.fn();
    mockGetCodexSessionLimitSnapshot.mockResolvedValue({
      source: "sdk_event",
      status: "warning",
      precision: "exact",
      checkedAt: "2026-04-18T05:00:00.000Z",
      providerId: "openai",
      runtimeId: "codex",
      profileId: "profile-1",
      primaryScope: "time",
      resetAt: "2099-04-18T10:00:00.000Z",
      retryAfterSeconds: null,
      warningThreshold: 10,
      windows: [
        {
          scope: "time",
          name: "5h",
          percentUsed: 92,
          percentRemaining: 8,
          resetAt: "2099-04-18T10:00:00.000Z",
          warningThreshold: 10,
        },
      ],
      providerMeta: {
        limitId: "codex",
        limitName: null,
        planType: "pro",
      },
    });
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-new" },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: "Streaming checkpoint" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
        },
      ]),
    });

    const result = await runCodexSdk(
      createRunInput({ profileId: "profile-1", execution: { onEvent } }),
    );

    expect(mockGetCodexSessionLimitSnapshot).toHaveBeenCalledWith({
      sessionId: "thread-new",
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime:limit",
          message: "Runtime limit state changed: warning",
        }),
      ]),
    );
    expect(result.events?.filter((event) => event.type === "runtime:limit")).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime:limit",
        message: "Runtime limit state changed: warning",
      }),
    );
    const emittedTypes = onEvent.mock.calls.map((call) => call[0]?.type);
    expect(emittedTypes.indexOf("runtime:limit")).toBeGreaterThanOrEqual(0);
    expect(emittedTypes.indexOf("result:success")).toBeGreaterThanOrEqual(0);
    expect(emittedTypes.indexOf("runtime:limit")).toBeLessThan(
      emittedTypes.indexOf("result:success"),
    );
  });

  it("resumes an existing thread when sessionId and resume are set", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-resumed" },
        { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "Continued" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 50, output_tokens: 25, cached_input_tokens: 0 },
        },
      ]),
    });

    const result = await runCodexSdk(createRunInput({ resume: true, sessionId: "thread-old" }));

    expect(mockResumeThread).toHaveBeenCalledWith("thread-old", expect.any(Object));
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(result.outputText).toBe("Continued");
    expect(result.sessionId).toBe("thread-resumed");
  });

  it("concatenates multiple agent messages", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-multi" },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: "First part" },
        },
        {
          type: "item.completed",
          item: { id: "msg-2", type: "agent_message", text: "Second part" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
      ]),
    });

    const result = await runCodexSdk(createRunInput());
    expect(result.outputText).toBe("First part\n\nSecond part");
  });

  it("invokes onToolUse callback for command execution items", async () => {
    const onToolUse = vi.fn();
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-tools" },
        {
          type: "item.completed",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "npm test",
            aggregated_output: "tests passed",
            status: "completed",
          },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ execution: { onToolUse } }));

    expect(onToolUse).toHaveBeenCalledWith("Bash", "npm test");
  });

  it("invokes onEvent callback for each runtime event", async () => {
    const onEvent = vi.fn();
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-events" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ execution: { onEvent } }));

    expect(onEvent).toHaveBeenCalled();
    const firstCall = onEvent.mock.calls[0][0];
    expect(firstCall.type).toBe("system:init");
  });

  it("throws on turn.failed event", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-fail" },
        { type: "turn.failed", error: { message: "Rate limit exceeded" } },
      ]),
    });

    await expect(runCodexSdk(createRunInput())).rejects.toThrow("Rate limit exceeded");
  });

  it("returns null usage when tokens are zero", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-no-usage" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    const result = await runCodexSdk(createRunInput());
    expect(result.usage).toBeNull();
  });

  it("passes model to thread options", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-model" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ model: "gpt-5.4" }));

    expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.4" }));
  });

  it("passes approval policy and sandbox mode from hooks to thread options (overriding non-bypass defaults)", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-approval" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        execution: {
          hooks: {
            approvalPolicy: "on-failure",
            sandboxMode: "read-only",
          },
        },
      }),
    );

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-failure",
        sandboxMode: "read-only",
      }),
    );
  });

  it("sets approvalPolicy=never and sandboxMode=danger-full-access when bypassPermissions is true", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-bypass" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        execution: { bypassPermissions: true },
      }),
    );

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      }),
    );
  });

  it("does not override explicit profile options.sandboxMode when bypassPermissions is true", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-bypass-override" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        options: { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
        execution: { bypassPermissions: true },
      }),
    );

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      }),
    );
  });

  it("applies stable non-bypass defaults (on-request + workspace-write) when bypassPermissions is absent", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-no-bypass" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput());

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      }),
    );
  });

  it("explicit profile options win over non-bypass defaults", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-explicit-non-bypass" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        options: { approvalPolicy: "on-failure", sandboxMode: "read-only" },
      }),
    );

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-failure",
        sandboxMode: "read-only",
      }),
    );
  });

  it("passes outputSchema to turn options", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-schema" },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: '{"summary":"ok"}' },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ execution: { outputSchema: schema } }));

    expect(mockRunStreamed).toHaveBeenCalledWith(
      "Implement the feature",
      expect.objectContaining({ outputSchema: schema }),
    );
  });

  it("maps file_change items to onToolUse callback", async () => {
    const onToolUse = vi.fn();
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-files" },
        {
          type: "item.completed",
          item: {
            id: "file-1",
            type: "file_change",
            changes: [
              { path: "src/index.ts", kind: "update" },
              { path: "src/new.ts", kind: "add" },
            ],
            status: "completed",
          },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ execution: { onToolUse } }));
    expect(onToolUse).toHaveBeenCalledWith("FileChange", "update src/index.ts, add src/new.ts");
  });

  it("serializes MCP tool arguments instead of coercing objects to [object Object]", async () => {
    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-mcp-tools" },
        {
          type: "item.completed",
          item: {
            id: "mcp-1",
            type: "mcp_tool_call",
            server: "handoff",
            tool: "list_mcp_resources",
            arguments: { cursor: "abc", limit: 20 },
            status: "completed",
          },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ execution: { onToolUse, onEvent } }));

    expect(onToolUse).toHaveBeenCalledWith(
      "MCP:handoff/list_mcp_resources",
      '{"cursor":"abc","limit":20}',
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool:summary",
        message: 'MCP:handoff/list_mcp_resources: {"cursor":"abc","limit":20}',
      }),
    );
  });

  it("does not forward npm_ environment keys into Codex SDK env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-sdk");
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-env" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput());

    const constructorOptions = mockCodexConstructor.mock.calls[0][0] as {
      env?: Record<string, string>;
    };
    expect(constructorOptions.env?.OPENAI_API_KEY).toBe("sk-sdk");
    expect(constructorOptions.env?.npm_config_registry).toBeUndefined();
  });

  it("prepends execution.systemPromptAppend to the user prompt (no native system slot on Thread)", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-sysappend" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        prompt: "Implement feature",
        execution: { systemPromptAppend: "Language policy: write in Russian." },
      }),
    );

    expect(mockRunStreamed).toHaveBeenCalledWith(
      "Language policy: write in Russian.\n\nImplement feature",
      expect.any(Object),
    );
  });

  it("prepends execution.systemPromptAppend to the resumed thread's prompt", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-resume-sysappend" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        resume: true,
        sessionId: "thread-old",
        prompt: "Continue feature",
        execution: { systemPromptAppend: "Language policy: write in Russian." },
      }),
    );

    expect(mockResumeThread).toHaveBeenCalledWith("thread-old", expect.any(Object));
    expect(mockRunStreamed).toHaveBeenCalledWith(
      "Language policy: write in Russian.\n\nContinue feature",
      expect.any(Object),
    );
  });

  it("leaves the prompt untouched when systemPromptAppend is absent", async () => {
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-no-sysappend" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(createRunInput({ prompt: "Implement feature" }));

    expect(mockRunStreamed).toHaveBeenCalledWith("Implement feature", expect.any(Object));
  });

  it("warns and falls back to stable defaults when thread permission overrides are invalid", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockRunStreamed.mockResolvedValue({
      events: createMockEvents([
        { type: "thread.started", thread_id: "thread-invalid-overrides" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        },
      ]),
    });

    await runCodexSdk(
      createRunInput({
        options: { approvalPolicy: "bad-policy", sandboxMode: "bad-sandbox" },
      }),
      logger,
    );

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "codex",
        transport: "sdk",
        field: "approvalPolicy",
        source: "options",
        invalidValue: "bad-policy",
      }),
      "Ignoring invalid Codex approvalPolicy override",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "codex",
        transport: "sdk",
        field: "sandboxMode",
        source: "options",
        invalidValue: "bad-sandbox",
      }),
      "Ignoring invalid Codex sandboxMode override",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "codex",
        transport: "sdk",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      }),
      "Resolved Codex SDK approval and sandbox settings",
    );
  });
});
