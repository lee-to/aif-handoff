import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, RuntimeRunInput } from "../../../types.js";
import { TEST_USAGE_CONTEXT } from "../../../__tests__/helpers/usageContext.js";

const {
  mockStdout,
  mockStderr,
  _mockStdin,
  mockChild,
  mockSpawn,
  mockSpawnSync,
  mockWithProcessTimeouts,
  mockSleepMs,
} = vi.hoisted(() => {
  const stdout = { on: vi.fn() };
  const stderr = { on: vi.fn() };
  const stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  const spawnSync = vi.fn().mockReturnValue({ status: 0 });
  const child = {
    pid: 1234,
    stdout,
    stderr,
    stdin,
    on: vi.fn(),
    kill: vi.fn(),
  };
  const spawn = vi.fn().mockReturnValue(child);
  return {
    mockStdout: stdout,
    mockStderr: stderr,
    _mockStdin: stdin,
    mockSpawnSync: spawnSync,
    mockSpawn: spawn,
    mockWithProcessTimeouts: vi.fn(),
    mockSleepMs: vi.fn(),
    mockChild: child,
  };
});

const mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    exec: vi.fn(),
  };
});

vi.mock("../../../timeouts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../timeouts.js")>();
  return {
    ...actual,
    withProcessTimeouts: (...args: any[]) => {
      if (mockWithProcessTimeouts.getMockImplementation()) {
        return mockWithProcessTimeouts(...args);
      }
      return (actual.withProcessTimeouts as any)(...args);
    },
    sleepMs: (...args: any[]) => {
      if (mockSleepMs.getMockImplementation()) {
        return mockSleepMs(...args);
      }
      return (actual.sleepMs as any)(...args);
    },
  };
});

const { runAntigravityCli, buildCuratedEnv } = await import("../cli.js");

function createInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "antigravity",
    providerId: "google",
    prompt: "Test prompt",
    options: {},
    projectRoot: "d:\\test-project",
    cwd: "d:\\test-project",
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

function findLastCall<T>(calls: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const item = calls[i];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function simulateStreamAndClose(code: number, jsonlLines: unknown[] = [], stderr = "") {
  const stdoutHandler = findLastCall(
    mockStdout.on.mock.calls,
    (c: unknown[]) => c[0] === "data",
  )?.[1] as ((chunk: string) => void) | undefined;
  for (const line of jsonlLines) {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    stdoutHandler?.(text + "\n");
  }

  if (stderr) {
    const stderrHandler = findLastCall(
      mockStderr.on.mock.calls,
      (c: unknown[]) => c[0] === "data",
    )?.[1] as ((chunk: string) => void) | undefined;
    stderrHandler?.(stderr);
  }

  const closeHandler = findLastCall(
    mockChild.on.mock.calls,
    (c: unknown[]) => c[0] === "close",
  )?.[1] as ((code: number) => void) | undefined;
  closeHandler?.(code);
}

describe("Antigravity CLI Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockClear();
    mockProcessKill.mockClear();
    mockProcessKill.mockImplementation((() => true) as any);
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0 });
    mockWithProcessTimeouts.mockReset();
    mockSleepMs.mockReset();
  });

  afterAll(() => {
    mockProcessKill.mockRestore();
  });

  it("streams text deltas, tool:use on ACTIVE, and tool:result on DONE", async () => {
    const onEvent = vi.fn();
    const onToolUse = vi.fn();
    const input = createInput({
      execution: {
        onEvent,
        onToolUse,
      },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "C:\\Users\\wait\\AppData\\Local\\agy\\bin\\agy.exe",
    });

    simulateStreamAndClose(0, [
      {
        event: "init",
        conversation_id: "conv-1234",
        init: { model: "gemini-3.8-flash-low", cwd: "d:\\test-project" },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo hello" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          duration_seconds: 0.25,
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo hello" },
            output: "hello\n",
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 2,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "The command printed: hello\n",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      },
      {
        event: "result",
        result: {
          conversation_id: "conv-1234",
          status: "SUCCESS",
          response: "The command printed: hello\n",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      },
    ]);

    const result = await runPromise;

    expect(result.outputText).toBe("The command printed: hello");
    expect(result.sessionId).toBe("conv-1234");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });

    // onToolUse was called exactly once on ACTIVE invocation
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith("run_command", expect.stringContaining("echo hello"));

    const emittedEvents: RuntimeEvent[] = onEvent.mock.calls.map((c) => c[0]);

    // tool:use was emitted once
    const toolUseEvents = emittedEvents.filter((e) => e.type === "tool:use");
    expect(toolUseEvents).toHaveLength(1);
    expect(toolUseEvents[0].data?.name).toBe("run_command");

    // tool:result was emitted once on completion
    const toolResultEvents = emittedEvents.filter((e) => e.type === "tool:result");
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0].data?.name).toBe("run_command");
    expect(toolResultEvents[0].data?.output).toBe("hello\n");

    // stream:text was emitted
    const textEvents = emittedEvents.filter((e) => e.type === "stream:text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].message).toBe("The command printed: hello\n");
  });

  it("decodes multi-byte UTF-8 stream output across split chunk boundaries without corruption", async () => {
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "C:\\Users\\wait\\AppData\\Local\\agy\\bin\\agy.exe",
    });

    const stdoutHandler = mockStdout.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined;
    const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
      | ((code: number) => void)
      | undefined;

    const fullJson =
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Привіт усім!",
        },
      }) + "\n";

    const buf = Buffer.from(fullJson, "utf8");
    // Find index of multi-byte char to split right in the middle of a 2-byte UTF-8 sequence
    const splitIndex = buf.indexOf(Buffer.from("Привіт", "utf8")) + 1; // splits 'П' between 0xd0 and 0x9f
    const chunk1 = buf.subarray(0, splitIndex);
    const chunk2 = buf.subarray(splitIndex);

    stdoutHandler?.(chunk1);
    stdoutHandler?.(chunk2);
    closeHandler?.(0);

    const result = await runPromise;
    expect(result.outputText).toBe("Привіт усім!");
    expect(result.outputText).not.toContain("\uFFFD");
  });

  it("spawns process with detached: !IS_WINDOWS", async () => {
    const { spawn } = await import("node:child_process");
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Done" } },
    ]);
    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "agy.exe",
      expect.any(Array),
      expect.objectContaining({
        detached: process.platform !== "win32",
      }),
    );
  });

  it("intercepts child.kill to terminate process tree via taskkill on Windows or process.kill on POSIX", async () => {
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    // Call the wrapped child.kill
    mockChild.kill("SIGTERM");

    if (process.platform === "win32") {
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
      );
    } else {
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    }

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Terminated" } },
    ]);
    await runPromise;
  });

  it("delivers prompt via child.stdin.write instead of CLI argument", async () => {
    const { spawn } = await import("node:child_process");
    const input = createInput({
      prompt: "Execute long prompt instruction",
      execution: {
        systemPromptAppend: "System appended rules",
      },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const lastCall = spawnCalls[spawnCalls.length - 1];
    const args = lastCall[1] as string[];

    expect(args).not.toContain("-p");
    expect(args).not.toContain("--prompt");
    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      "Execute long prompt instruction\n\n[SYSTEM INSTRUCTIONS]:\nSystem appended rules",
      "utf8",
    );
    expect(mockChild.stdin.end).toHaveBeenCalled();

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Done" } },
    ]);
    await runPromise;
  });

  it("handles non-zero child exit code with stderr", async () => {
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(1, [], "Fatal binary failure");

    await expect(runPromise).rejects.toThrow(
      "Antigravity CLI exited with code 1: Fatal binary failure",
    );
  });

  it("handles child process error event", async () => {
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const errorHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "error")?.[1] as
      | ((err: Error) => void)
      | undefined;
    errorHandler?.(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    await expect(runPromise).rejects.toThrow();
  });

  it("handles pre-aborted controller", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const input = createInput({
      execution: { abortController },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    if (process.platform === "win32") {
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
    } else {
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    }

    simulateStreamAndClose(0, []);
    await expect(runPromise).rejects.toThrow("Antigravity execution was aborted");
  });

  it("handles abortion while running", async () => {
    const abortController = new AbortController();
    const input = createInput({
      execution: { abortController },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    abortController.abort();

    if (process.platform === "win32") {
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "taskkill",
        ["/PID", "1234", "/T", "/F"],
        expect.any(Object),
      );
    } else {
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    }

    simulateStreamAndClose(0, []);
    await expect(runPromise).rejects.toThrow("Antigravity execution was aborted");
  });

  it("handles plain text non-JSON stream fallback and circular inputs in tools", async () => {
    const input = createInput({
      sessionId: "12345678-1234-1234-1234-123456789abc",
      execution: {
        bypassPermissions: true,
      },
      options: {
        effort: "high",
      },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const longString = "A".repeat(120);
    const complexObj = { key: "value".repeat(25) };

    simulateStreamAndClose(0, [
      "not a json line",
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_calls: [
            { name: "tool1", id: "call_1", input: longString },
            { name: "tool2", id: "call_2", input: complexObj },
          ],
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "tool1",
          tool_id: "call_1",
          tool_info: { output: { res: "ok" } },
        },
      },
      "trailing plain text line",
    ]);

    const result = await runPromise;
    expect(result.outputText).toContain("not a json line");
    expect(result.outputText).toContain("trailing plain text line");
  });

  it("supports custom logger calls throughout run", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const input = createInput();
    const runPromise = runAntigravityCli(input, logger, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0, [{ event: "result", result: { status: "SUCCESS", response: "OK" } }]);

    await runPromise;
    expect(logger.info).toHaveBeenCalled();
  });

  it("retries on start timeout and returns result when retry succeeds", async () => {
    mockSleepMs.mockResolvedValue(undefined);
    mockWithProcessTimeouts
      .mockReturnValueOnce({
        cleanup: vi.fn(),
        startTimedOut: Promise.resolve(true),
        runTimedOut: false,
      })
      .mockReturnValueOnce({
        cleanup: vi.fn(),
        startTimedOut: Promise.resolve(false),
        runTimedOut: false,
      });

    const input = createInput({
      execution: { startTimeoutMs: 1000, startRetryDelayMs: 0 },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    // Close attempt 1
    simulateStreamAndClose(0);

    // Wait for retry to spawn and simulate attempt 2
    await vi.waitFor(() => {
      expect(mockWithProcessTimeouts).toHaveBeenCalledTimes(2);
    });

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Retry success" } },
    ]);

    const result = await runPromise;
    expect(result.outputText).toBe("Retry success");
  });

  it("throws makeProcessStartTimeoutError when start timeout fails on retry", async () => {
    mockSleepMs.mockResolvedValue(undefined);
    mockWithProcessTimeouts
      .mockReturnValueOnce({
        cleanup: vi.fn(),
        startTimedOut: Promise.resolve(true),
        runTimedOut: false,
      })
      .mockReturnValueOnce({
        cleanup: vi.fn(),
        startTimedOut: Promise.resolve(true),
        runTimedOut: false,
      });

    const input = createInput({
      execution: { startTimeoutMs: 1000, startRetryDelayMs: 0 },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0);

    await vi.waitFor(() => {
      expect(mockWithProcessTimeouts).toHaveBeenCalledTimes(2);
    });

    simulateStreamAndClose(0);

    await expect(runPromise).rejects.toThrow("runtime produced no output");
  });

  it("removes abort listener from abortSignal when process closes", async () => {
    const abortController = new AbortController();
    const removeEventListenerSpy = vi.spyOn(abortController.signal, "removeEventListener");

    const input = createInput({
      execution: { abortController },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Clean exit" } },
    ]);
    await runPromise;

    expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("ensures child.kill is idempotent and does not run killProcessTree repeatedly", async () => {
    mockSpawnSync.mockClear();
    mockProcessKill.mockClear();
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    mockChild.kill("SIGTERM");
    mockChild.kill("SIGKILL");

    if (process.platform === "win32") {
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    } else {
      expect(mockProcessKill).toHaveBeenCalledTimes(1);
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    }

    simulateStreamAndClose(0, [{ event: "result", result: { status: "SUCCESS", response: "OK" } }]);
    await runPromise;
  });

  it("flushes complete lines and trailing json line when stream closes without trailing newline", async () => {
    const onStderr = vi.fn();
    const input = createInput({
      execution: { onStderr },
    });
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const stdoutHandler = mockStdout.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined;
    const stderrHandler = mockStderr.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: Buffer | string) => void)
      | undefined;
    const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
      | ((code: number) => void)
      | undefined;

    // Send line 1 with newline, and line 2 without trailing newline
    const line1 = JSON.stringify({ event: "step_update", step_update: { step_index: 1 } }) + "\n";
    const line2 = JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "Flushed on close" },
    });

    stdoutHandler?.(line1);
    stdoutHandler?.(line2); // no trailing newline
    stderrHandler?.("Trailing stderr note");

    closeHandler?.(0);

    const result = await runPromise;
    expect(result.outputText).toBe("Flushed on close");
    expect(onStderr).toHaveBeenCalledWith(expect.stringContaining("Trailing stderr note"));
  });

  it("composes prompt with input.systemPrompt when provided", async () => {
    const input = createInput({
      systemPrompt: "Base system instruction",
      prompt: "User query",
      execution: {
        systemPromptAppend: "System append instruction",
      },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      "[SYSTEM PROMPT]:\nBase system instruction\n\nUser query\n\n[SYSTEM INSTRUCTIONS]:\nSystem append instruction",
      "utf8",
    );

    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Done" } },
    ]);
    await runPromise;
  });

  it("rejects batch script executable paths (.cmd and .bat) across all platforms", async () => {
    const inputCmd = createInput();
    await expect(
      runAntigravityCli(inputCmd, undefined, {
        pathToAntigravityExecutable: "scripts/run.cmd",
      }),
    ).rejects.toThrow(/is prohibited/);

    await expect(
      runAntigravityCli(inputCmd, undefined, {
        pathToAntigravityExecutable: "scripts/run.cmd",
      }),
    ).rejects.toMatchObject({
      adapterCode: "ANTIGRAVITY_SECURITY_VIOLATION",
      category: "permission",
    });

    const inputBat = createInput();
    await expect(
      runAntigravityCli(inputBat, undefined, {
        pathToAntigravityExecutable: "scripts/run.bat",
      }),
    ).rejects.toThrow(/is prohibited/);

    await expect(
      runAntigravityCli(inputBat, undefined, {
        pathToAntigravityExecutable: "scripts/run.bat",
      }),
    ).rejects.toMatchObject({
      adapterCode: "ANTIGRAVITY_SECURITY_VIOLATION",
      category: "permission",
    });
  });

  it("rejects with makeProcessRunTimeoutError when process execution times out", async () => {
    mockWithProcessTimeouts.mockReturnValueOnce({
      cleanup: vi.fn(),
      startTimedOut: Promise.resolve(false),
      runTimedOut: true,
    });

    const input = createInput({
      execution: { runTimeoutMs: 5000 },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0, []);

    await expect(runPromise).rejects.toThrow("Run timeout: execution exceeded 5000ms limit");
  });

  it("captures and rejects on stream processing error when event listener throws", async () => {
    const errorListener = vi.fn().mockImplementation(() => {
      throw new Error("Consumer onEvent crash");
    });

    const input = createInput({
      execution: {
        onEvent: errorListener,
      },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    // Send a valid JSON line that will trigger onEvent and throw
    simulateStreamAndClose(0, [
      { event: "result", result: { status: "SUCCESS", response: "Done" } },
    ]);

    await expect(runPromise).rejects.toThrow("Consumer onEvent crash");
  });

  it("handles error event followed by close event without duplicate cleanup or unhandled rejection", async () => {
    const input = createInput();
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const errorHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "error")?.[1] as
      | ((err: Error) => void)
      | undefined;
    const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
      | ((code: number) => void)
      | undefined;

    // Trigger error then close
    errorHandler?.(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    closeHandler?.(1);

    await expect(runPromise).rejects.toThrow();
  });

  it("aborts during start timeout retry delay without spawning second attempt", async () => {
    const abortController = new AbortController();
    mockWithProcessTimeouts.mockReturnValueOnce({
      cleanup: vi.fn(),
      startTimedOut: Promise.resolve(true),
      runTimedOut: false,
    });

    mockSleepMs.mockImplementation(async () => {
      abortController.abort();
    });

    const input = createInput({
      execution: { startTimeoutMs: 1000, startRetryDelayMs: 100, abortController },
    });

    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    simulateStreamAndClose(0);

    await expect(runPromise).rejects.toThrow("Antigravity execution was aborted");
    expect(mockWithProcessTimeouts).toHaveBeenCalledTimes(1);
  });

  it("does not include --project flag when options.project is omitted", async () => {
    const input = createInput({ options: {} });
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });
    simulateStreamAndClose(0, []);
    await runPromise;

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).not.toContain("--project");
  });

  it("includes --project flag when options.project is specified", async () => {
    const input = createInput({ options: { project: "my-existing-project" } });
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });
    simulateStreamAndClose(0, []);
    await runPromise;

    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toBeDefined();
    const projectIdx = spawnArgs!.indexOf("--project");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs![projectIdx + 1]).toBe("my-existing-project");
  });

  it("preserves Windows environment variables case-insensitively (Path, SystemRoot, TEMP, TMP)", () => {
    const mockEnv: Record<string, string> = {
      Path: "C:\\Windows\\system32;C:\\Windows",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      TEMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\test\\AppData\\Local\\Temp",
      ANTIGRAVITY_API_KEY: "test-key",
      HOME: "/home/test",
      UNRELATED_SECRET: "should-be-stripped",
    };

    const env = buildCuratedEnv(undefined, mockEnv);

    expect(env).toHaveProperty("Path", "C:\\Windows\\system32;C:\\Windows");
    expect(env).toHaveProperty("SystemRoot", "C:\\Windows");
    expect(env).toHaveProperty("ComSpec", "C:\\Windows\\system32\\cmd.exe");
    expect(env).toHaveProperty("TEMP", "C:\\Users\\test\\AppData\\Local\\Temp");
    expect(env).toHaveProperty("TMP", "C:\\Users\\test\\AppData\\Local\\Temp");
    expect(env).toHaveProperty("ANTIGRAVITY_API_KEY", "test-key");
    expect(env).toHaveProperty("HOME", "/home/test");
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("caps accumulated stderr buffer to 64KB while continuing to forward all chunks to onStderr", async () => {
    const onStderr = vi.fn();
    const input = createInput({
      execution: { onStderr },
    });
    const runPromise = runAntigravityCli(input, undefined, {
      pathToAntigravityExecutable: "agy.exe",
    });

    const stderrHandler = mockStderr.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: string) => void)
      | undefined;
    const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
      | ((code: number) => void)
      | undefined;

    // Simulate sending 100 chunks of 1KB text (100KB > 64KB limit)
    const chunk = "E".repeat(1024);
    for (let i = 0; i < 100; i++) {
      stderrHandler?.(chunk);
    }

    // Process exits with error code 1 to inspect accumulated stderr in rejected error
    closeHandler?.(1);

    await expect(runPromise).rejects.toThrow();
    // onStderr should have received all 100 calls
    expect(onStderr).toHaveBeenCalledTimes(100);

    // Verify rejection error message does not blow up past ~64KB
    try {
      await runPromise;
    } catch (err: any) {
      expect(err.message.length).toBeLessThanOrEqual(65_536 + 1000);
    }
  });
});
