import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";

// Mock the Codex SDK
const mockRunStreamed = vi.fn();
const mockThread = {
  id: "thread-abc123",
  runStreamed: mockRunStreamed,
};
const mockStartThread = vi.fn().mockReturnValue(mockThread);
const mockResumeThread = vi.fn().mockReturnValue(mockThread);

class MockCodex {
  startThread = mockStartThread;
  resumeThread = mockResumeThread;
}

vi.mock("@openai/codex-sdk", () => ({
  Codex: MockCodex,
}));

const { runCodexSdk } = await import("../adapters/codex/sdk.js");

function createRunInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "codex",
    providerId: "openai",
    prompt: "Implement the feature",
    options: {},
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
    mockStartThread.mockReturnValue(mockThread);
    mockResumeThread.mockReturnValue(mockThread);
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
});
