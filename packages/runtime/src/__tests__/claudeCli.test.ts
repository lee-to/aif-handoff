import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { getCliSpawnInvocation } from "./helpers/cliSpawn.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

// vi.hoisted ensures the mock fixtures initialize before vi.mock's hoisted
// factory runs. Without this, the factory below hits a TDZ error trying to
// read `mockChild` — vi.mock is hoisted above regular top-level code.
const { mockStdout, mockStderr, mockStdin, mockChild } = vi.hoisted(() => {
  const stdout = { on: vi.fn() };
  const stderr = { on: vi.fn() };
  const stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  return {
    mockStdout: stdout,
    mockStderr: stderr,
    mockStdin: stdin,
    mockChild: {
      stdout,
      stderr,
      stdin,
      on: vi.fn(),
      kill: vi.fn(),
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue(mockChild),
}));

const { spawn } = await import("node:child_process");
const { runClaudeCli } = await import("../adapters/claude/cli.js");

function createInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "claude",
    providerId: "anthropic",
    prompt: "Implement the feature",
    options: {},
    projectRoot: "/tmp/project",
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

/**
 * Simulate the CLI stdout stream by firing each JSONL line as a separate
 * `data` chunk, then firing `close` with the given exit code. Optionally
 * feeds stderr text.
 */
function simulateStreamAndClose(code: number, jsonlLines: unknown[] = [], stderr = "") {
  const stdoutHandler = mockStdout.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
    | ((chunk: string) => void)
    | undefined;
  for (const line of jsonlLines) {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    stdoutHandler?.(text + "\n");
  }

  if (stderr) {
    const stderrHandler = mockStderr.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: string) => void)
      | undefined;
    stderrHandler?.(stderr);
  }

  const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
    | ((code: number) => void)
    | undefined;
  closeHandler?.(code);
}

/** Build a typical successful stream-json transcript. */
function successfulStream(options: {
  sessionId: string;
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  totalCostUsd?: number;
}) {
  const { sessionId, text, usage, totalCostUsd } = options;
  return [
    { type: "system", subtype: "init", session_id: sessionId, model: "claude-haiku" },
    {
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: text,
      usage,
      total_cost_usd: totalCostUsd,
      num_turns: 1,
      duration_ms: 500,
    },
  ];
}

function getSpawnInvocation() {
  return getCliSpawnInvocation(spawn as ReturnType<typeof vi.fn>);
}

describe("runClaudeCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChild.on.mockReset();
    mockStdout.on.mockReset();
    mockStderr.on.mockReset();
    mockStdin.on.mockReset();
    mockStdin.write.mockReset();
    mockStdin.end.mockReset();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns claude CLI with stream-json args and streams the prompt via stdin", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(
      0,
      successfulStream({
        sessionId: "sess-1",
        text: "Done",
        usage: { input_tokens: 100, output_tokens: 50 },
        totalCostUsd: 0.01,
      }),
    );

    const result = await promise;
    expect(result.outputText).toBe("Done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.costUsd).toBe(0.01);

    const { cliPath, cliArgs, spawnOptions } = getSpawnInvocation();
    expect(cliPath).toBe("claude");
    expect(cliArgs).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "-p",
      ]),
    );
    // Prompt is no longer on argv — it is streamed via stdin
    expect(cliArgs).not.toContain("Implement the feature");
    expect(mockStdin.write).toHaveBeenCalledWith("Implement the feature");
    expect(mockStdin.end).toHaveBeenCalled();
    expect(spawnOptions).toEqual(expect.objectContaining({ cwd: "/tmp/project" }));
  });

  it("passes very large prompts via stdin without putting them on argv", async () => {
    // 2 MB prompt — well beyond macOS ARG_MAX (1 MiB) and Windows cmd.exe (~8 KB).
    const largePrompt = "x".repeat(2_000_000);
    const input = createInput({ prompt: largePrompt });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-large", text: "ok" }));
    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).not.toContain(largePrompt);
    // argv stays small — total size is a few hundred bytes of flags
    const argvSize = cliArgs.reduce((sum, arg) => sum + arg.length, 0);
    expect(argvSize).toBeLessThan(1_000);
    expect(mockStdin.write).toHaveBeenCalledWith(largePrompt);
  });

  it("emits stream:text events as assistant text chunks arrive and accumulates outputText", async () => {
    const onEvent = vi.fn();
    const input = createInput({ execution: { onEvent } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-multi" },
      {
        type: "assistant",
        session_id: "sess-multi",
        message: { content: [{ type: "text", text: "Hello " }] },
      },
      {
        type: "assistant",
        session_id: "sess-multi",
        message: { content: [{ type: "text", text: "world" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-multi",
        result: "Hello world",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("Hello world");

    const textEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; message?: string })
      .filter((e) => e.type === "stream:text");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]?.message).toBe("Hello ");
    expect(textEvents[1]?.message).toBe("world");

    const initEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "system:init");
    expect(initEvents).toHaveLength(1);

    const resultEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "result:success");
    expect(resultEvents).toHaveLength(1);
  });

  it("calls onToolUse and emits tool:use event for tool_use content blocks", async () => {
    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    const input = createInput({ execution: { onToolUse, onEvent } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-tool" },
      {
        type: "assistant",
        session_id: "sess-tool",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Edit",
              input: { file_path: "/a.ts", old: "x", new: "y" },
            },
          ],
        },
      },
      {
        type: "assistant",
        session_id: "sess-tool",
        message: { content: [{ type: "text", text: "Applied the edit." }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-tool",
        result: "Applied the edit.",
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("Applied the edit.");

    expect(onToolUse).toHaveBeenCalledTimes(1);
    const [toolName, detail] = onToolUse.mock.calls[0];
    expect(toolName).toBe("Edit");
    expect(detail).toContain("file_path");

    const toolEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; data?: { name?: string } })
      .filter((e) => e.type === "tool:use");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.data?.name).toBe("Edit");
  });

  it("includes --agent flag when agentDefinitionName is set", async () => {
    const input = createInput({
      execution: { agentDefinitionName: "plan-coordinator" },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-agent", text: "Planned" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--agent");
    expect(cliArgs[cliArgs.indexOf("--agent") + 1]).toBe("plan-coordinator");
  });

  it("includes --model flag when model is set", async () => {
    const input = createInput({ model: "claude-opus-4-1" });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-model", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--model");
    expect(cliArgs).toContain("claude-opus-4-1");
  });

  it("includes --effort flag when options.effort is set to a valid level", async () => {
    const input = createInput({ options: { effort: "high" } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-effort", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--effort");
    expect(cliArgs[cliArgs.indexOf("--effort") + 1]).toBe("high");
  });

  it("normalizes numeric effort values to named levels on the CLI", async () => {
    const input = createInput({ options: { effort: 4 } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-effort-num", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--effort");
    expect(cliArgs[cliArgs.indexOf("--effort") + 1]).toBe("max");
  });

  it("omits --effort when options.effort is not provided or invalid", async () => {
    const input = createInput({ options: { effort: "bogus" } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-no-effort", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).not.toContain("--effort");
  });

  it("includes --resume flag for session continuation", async () => {
    const input = createInput({ resume: true, sessionId: "sess-existing" });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-existing", text: "Resumed" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--resume");
    expect(cliArgs).toContain("sess-existing");
  });

  it("includes --include-partial-messages when execution.includePartialMessages is true", async () => {
    const input = createInput({ execution: { includePartialMessages: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-partial", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--include-partial-messages");
  });

  it("accumulates text deltas from stream_event content_block_delta (partial messages)", async () => {
    const input = createInput({ execution: { includePartialMessages: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-delta" },
      {
        type: "stream_event",
        session_id: "sess-delta",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "par" },
        },
      },
      {
        type: "stream_event",
        session_id: "sess-delta",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "tial" },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-delta",
        result: "partial",
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("partial");
  });

  it("does NOT double-emit stream:text when include-partial-messages is on (deltas + assistant block together)", async () => {
    // When --include-partial-messages is enabled, Claude emits BOTH
    // stream_event deltas AND the complete assistant content block for the
    // same text. The adapter must rely on deltas only so the chat route
    // doesn't concatenate the full text twice into fullAssistantResponse.
    const onEvent = vi.fn();
    const input = createInput({
      prompt: "say hi",
      execution: { includePartialMessages: true, onEvent },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-dedup" },
      {
        type: "stream_event",
        session_id: "sess-dedup",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "hi" },
        },
      },
      // Complete assistant block arrives after the delta with the same text
      {
        type: "assistant",
        session_id: "sess-dedup",
        message: {
          model: "claude-haiku",
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-dedup",
        result: "hi",
      },
    ]);

    const result = await promise;
    // Final output text should be "hi", NOT "hihi"
    expect(result.outputText).toBe("hi");

    const streamTextEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; message?: string })
      .filter((e) => e.type === "stream:text");
    // Exactly ONE stream:text event — from the delta, not the assistant block
    expect(streamTextEvents).toHaveLength(1);
    expect(streamTextEvents[0]?.message).toBe("hi");
  });

  it("still emits tool:use from assistant blocks even when partial messages is on", async () => {
    // Tool use content blocks are NOT streamed as deltas, only the complete
    // assistant block carries them. Partial-messages mode must not suppress
    // tool:use emission.
    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    const input = createInput({
      execution: { includePartialMessages: true, onToolUse, onEvent },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-tool-partial" },
      {
        type: "assistant",
        session_id: "sess-tool-partial",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-tool-partial",
        result: "",
      },
    ]);

    await promise;

    expect(onToolUse).toHaveBeenCalledTimes(1);
    const toolEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; data?: { name?: string } })
      .filter((e) => e.type === "tool:use");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.data?.name).toBe("Bash");
  });

  it("uses --dangerously-skip-permissions when bypassPermissions is true", async () => {
    const input = createInput({ execution: { bypassPermissions: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-bypass", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--dangerously-skip-permissions");
    expect(cliArgs).not.toContain("acceptEdits");
  });

  it("throws classified error on non-zero exit code", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(1, [], "Authentication failed");

    await expect(promise).rejects.toThrow();
  });

  it("throws classified error when result message has is_error: true", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-err" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-err",
        result: "Permission denied",
      },
    ]);

    await expect(promise).rejects.toThrow();
  });

  it("falls back to plain text when stdout is not JSONL", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, ["plain text output"]);

    const result = await promise;
    expect(result.outputText).toBe("plain text output");
  });

  it("uses custom CLI path from options", async () => {
    const input = createInput({
      options: { claudeCliPath: "/custom/bin/claude" },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-custom", text: "Done" }));

    await promise;

    const { cliPath } = getSpawnInvocation();
    expect(cliPath).toBe("/custom/bin/claude");
  });

  it("calls onStderr callback for stderr output", async () => {
    const onStderr = vi.fn();
    const input = createInput({ execution: { onStderr } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(
      0,
      successfulStream({ sessionId: "sess-stderr", text: "Done" }),
      "some warning",
    );

    await promise;

    expect(onStderr).toHaveBeenCalledWith("some warning");
  });
});
