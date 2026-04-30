import { describe, expect, it, vi } from "vitest";
import { RuntimeTransport, UsageSource, type RuntimeRunInput } from "../../../../types.js";
import { CodexAppServerEventMapper } from "../eventMapper.js";

function createInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "chat",
    transport: RuntimeTransport.APP_SERVER,
    prompt: "hello",
    options: {},
    usageContext: {
      source: UsageSource.CHAT,
      projectId: "project-1",
      chatSessionId: "chat-1",
    },
    execution: {},
    ...overrides,
  };
}

describe("codex app-server event mapper", () => {
  it("captures thread/turn ids and emits init + turn-start events", () => {
    const onEvent = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput({
        execution: {
          onEvent,
        },
      }),
    });

    mapper.handleNotification("thread/started", { threadId: "thread-1" });
    mapper.handleNotification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    });

    expect(mapper.getThreadId()).toBe("thread-1");
    expect(mapper.getTurnId()).toBe("turn-1");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system:init",
        data: expect.objectContaining({
          sessionId: "thread-1",
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn:started",
        data: expect.objectContaining({
          turnId: "turn-1",
        }),
      }),
    );
  });

  it("maps agent/reasoning/tool completion notifications into runtime events", () => {
    const onEvent = vi.fn();
    const onToolUse = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput({
        execution: {
          onEvent,
          onToolUse,
        },
      }),
    });

    mapper.handleNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "first",
    });
    mapper.handleNotification("item/completed", {
      item: {
        id: "message-1",
        type: "agentMessage",
        text: "first",
      },
    });
    mapper.handleNotification("item/completed", {
      item: {
        type: "reasoning",
        text: "thinking",
      },
    });
    mapper.handleNotification("item/completed", {
      item: {
        type: "commandExecution",
        command: "echo hello",
      },
    });
    mapper.handleNotification("item/completed", {
      item: {
        type: "fileChange",
        changes: [
          {
            kind: "update",
            path: "src/file.ts",
          },
        ],
      },
    });
    mapper.handleNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        server: "notion",
        tool: "search",
        arguments: {
          query: "status",
        },
      },
    });
    mapper.handleNotification("item/completed", {
      item: {
        type: "webSearch",
        query: "codex app-server",
      },
    });

    expect(mapper.getOutputText()).toContain("first");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "stream:text" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "reasoning:summary" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool:summary" }));
    expect(onToolUse).toHaveBeenCalledWith("Bash", expect.stringContaining("echo hello"));
    expect(onToolUse).toHaveBeenCalledWith("FileChange", expect.stringContaining("src/file.ts"));
    expect(onToolUse).toHaveBeenCalledWith("MCP:notion/search", expect.stringContaining("status"));
    expect(onToolUse).toHaveBeenCalledWith("WebSearch", "codex app-server");
  });

  it("preserves whitespace-only agent message deltas", () => {
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
    });

    mapper.handleNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "Hello",
    });
    mapper.handleNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: " ",
    });
    mapper.handleNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "world",
    });

    expect(mapper.getOutputText()).toBe("Hello world");
  });

  it("ignores empty and non-string agent message deltas", () => {
    const onEvent = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput({
        execution: {
          onEvent,
        },
      }),
    });

    mapper.handleNotification("item/agentMessage/delta", {
      delta: "",
    });
    mapper.handleNotification("item/agentMessage/delta", {
      delta: 123,
    });

    expect(mapper.getOutputText()).toBe("");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("handles known account and thread status notifications without warnings", () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
      logger: {
        warn,
        debug,
      },
    });

    mapper.handleNotification("account/rateLimits/updated", {
      rateLimits: [],
    });
    mapper.handleNotification("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(2);
    expect(mapper.getThreadId()).toBe("thread-1");
  });

  it("silently handles high-volume app-server progress notifications", () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const onEvent = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput({
        execution: {
          onEvent,
        },
      }),
      logger: {
        warn,
        debug,
      },
    });

    for (const method of [
      "command/exec/outputDelta",
      "item/commandExecution/outputDelta",
      "item/commandExecution/terminalInteraction",
      "item/fileChange/outputDelta",
      "item/mcpToolCall/progress",
      "item/plan/delta",
      "item/autoApprovalReview/started",
      "item/autoApprovalReview/completed",
    ]) {
      mapper.handleNotification(method, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "chunk",
      });
    }

    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("handles known account and thread status notifications without a logger", () => {
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
    });

    mapper.handleNotification("account/rateLimits/updated", {
      rateLimits: [],
    });
    mapper.handleNotification("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    expect(mapper.getThreadId()).toBe("thread-1");
  });

  it("sanitizes approval payloads and strips private reasoning fields", () => {
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
    });

    mapper.handleNotification("item/commandExecution/requestApproval", {
      command: "npm install",
      reasoning: "secret",
      nested: {
        analysis: "internal",
        safe: "keep",
      },
    });

    const approvalEvent = mapper.getEvents().find((event) => event.type === "approval:request");
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent?.data).toMatchObject({
      command: "npm install",
      nested: {
        safe: "keep",
      },
    });
    expect(approvalEvent?.data).not.toHaveProperty("reasoning");
    expect((approvalEvent?.data as Record<string, unknown>).nested).not.toHaveProperty("analysis");
  });

  it("returns explicit denial responses for every known approval server request", () => {
    const warn = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
      logger: { warn },
    });

    const cases: Array<[string, unknown]> = [
      ["item/commandExecution/requestApproval", { decision: "decline" }],
      ["item/fileChange/requestApproval", { decision: "decline" }],
      ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
      ["applyPatchApproval", { decision: "denied" }],
      ["execCommandApproval", { decision: "denied" }],
    ];

    for (const [method, expected] of cases) {
      expect(
        mapper.handleServerRequest(method, {
          command: "npm test",
          reasoning: "private",
          nested: { analysis: "private", safe: "visible" },
        }),
      ).toEqual(expected);
    }

    const approvalEvents = mapper.getEvents().filter((event) => event.type === "approval:request");
    expect(approvalEvents).toHaveLength(cases.length);
    expect(approvalEvents.at(-1)?.data).toMatchObject({
      command: "npm test",
      nested: { safe: "visible" },
    });
    expect(approvalEvents.at(-1)?.data).not.toHaveProperty("reasoning");
    expect(warn).toHaveBeenCalledTimes(cases.length);
  });

  it("captures usage on turn completion and propagates turn failures", () => {
    const onTurnCompleted = vi.fn();
    const onTurnFailed = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
      onTurnCompleted,
      onTurnFailed,
    });

    mapper.handleNotification("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    });
    mapper.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    expect(mapper.isCompleted()).toBe(true);
    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(mapper.getUsage()).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });

    mapper.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: {
          message: "simulated failure",
          category: "transport",
          adapterCode: "CODEX_TRANSPORT_ERROR",
        },
      },
    });

    expect(onTurnFailed).toHaveBeenCalledTimes(1);
    expect(mapper.getFailure()).toBeInstanceOf(Error);
    expect(mapper.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "result:error",
        data: expect.objectContaining({
          category: "transport",
          adapterCode: "CODEX_TRANSPORT_ERROR",
        }),
      }),
    );
  });

  it("logs unknown notifications as non-fatal warnings", () => {
    const warn = vi.fn();
    const mapper = new CodexAppServerEventMapper({
      input: createInput(),
      logger: {
        warn,
      },
    });

    mapper.handleNotification("custom/unhandled/notification", {
      hello: "world",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
