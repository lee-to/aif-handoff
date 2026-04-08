import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCliSpawnInvocation } from "./helpers/cliSpawn.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { runCodexCli } = await import("../adapters/codex/cli.js");

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  kill: ReturnType<typeof vi.fn>;
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  child.stdin = Object.assign(stdinEmitter, {
    write: vi.fn(),
    end: vi.fn(),
  }) as MockChildProcess["stdin"];
  child.kill = vi.fn();
  return child;
}

function getSpawnInvocation() {
  return getCliSpawnInvocation(spawnMock);
}

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    model: "gpt-5.4",
    sessionId: "session-1",
    options: {},
    ...overrides,
  };
}

describe("codex cli transport", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("runs codex cli with default args and passes prompt as positional arg", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const { cliPath, cliArgs: args } = getSpawnInvocation();
    expect(cliPath).toBe("codex");
    expect(args).toEqual(["exec", "--json", "--model", "gpt-5.4", "Implement feature"]);
    expect(child.stdin.write).not.toHaveBeenCalled();

    child.stdout.emit("data", "plain output");
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("plain output");
    expect(result.sessionId).toBe("session-1");
    expect(result.raw).toBe("plain output");
  });

  it("uses exec resume subcommand when resume and sessionId are set", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput({ resume: true, sessionId: "thread-abc" }));

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toEqual([
      "exec",
      "resume",
      "thread-abc",
      "--json",
      "--model",
      "gpt-5.4",
      "Implement feature",
    ]);

    child.stdout.emit("data", "resumed output");
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("resumed output");
  });

  it("supports cli args placeholders and parses JSON output", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const runPromise = runCodexCli(
      createRunInput({
        options: {
          codexCliPath: "/usr/local/bin/codex",
          codexCliArgs: [
            "run",
            "--json",
            "--prompt={prompt}",
            "--model={model}",
            "--session={session_id}",
          ],
          apiKeyEnvVar: "OPENAI_API_KEY",
        },
      }),
    );

    const {
      cliPath,
      cliArgs: args,
      spawnOptions,
    } = getSpawnInvocation() as {
      cliPath: string;
      cliArgs: string[];
      spawnOptions: { env?: Record<string, string> };
    };
    expect(cliPath).toBe("/usr/local/bin/codex");
    expect(args).toEqual([
      "run",
      "--json",
      "--prompt=Implement feature",
      "--model=gpt-5.4",
      "--session=session-1",
    ]);
    expect(spawnOptions.env?.OPENAI_API_KEY).toBe("sk-test");
    expect(child.stdin.write).not.toHaveBeenCalled();

    child.stdout.emit(
      "data",
      JSON.stringify({
        outputText: "json output",
        sessionId: "session-2",
        usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.3 },
        events: [{ type: "stream:text", message: "delta" }],
      }),
    );
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("json output");
    expect(result.sessionId).toBe("session-2");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      costUsd: 0.3,
    });
    expect(result.events?.[0]?.type).toBe("stream:text");
  });

  it("throws classified error when CLI exits with non-zero code", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());
    child.stderr.emit("data", "unauthorized");
    child.emit("close", 1);

    await expect(runPromise).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_AUTH_ERROR",
    });
  });

  it("throws classified error when spawn emits error", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());
    child.emit("error", new Error("spawn ENOENT"));

    await expect(runPromise).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_CLI_NOT_FOUND",
    });
  });

  it("excludes OPENAI_BASE_URL from child env to prevent deprecated endpoint override", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");

    const runPromise = runCodexCli(createRunInput());

    const [, , spawnOptions] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(spawnOptions.env?.OPENAI_API_KEY).toBe("sk-test");
    expect(spawnOptions.env?.OPENAI_BASE_URL).toBeUndefined();
    expect(spawnOptions.env?.npm_config_registry).toBeUndefined();

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("kills process and throws timeout error when run exceeds timeout", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(
      createRunInput({
        execution: { runTimeoutMs: 5 },
      }),
    );

    vi.advanceTimersByTime(5);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 0);

    await expect(runPromise).rejects.toMatchObject({
      name: "RuntimeExecutionError",
      category: "timeout",
    });
  });

  it("retries once after start timeout and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const child1 = createMockChildProcess();
    const child2 = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const runPromise = runCodexCli(
      createRunInput({
        execution: { startTimeoutMs: 10, startRetryDelayMs: 0, runTimeoutMs: 60_000 },
      }),
    );

    // First attempt: no output → start timeout fires
    vi.advanceTimersByTime(10);
    expect(child1.kill).toHaveBeenCalledWith("SIGKILL");
    child1.emit("close", null);

    // Let async close handler + retry settle
    await vi.advanceTimersByTimeAsync(1);

    // Second attempt succeeds
    expect(spawnMock).toHaveBeenCalledTimes(2);
    child2.stdout.emit("data", "retry output");
    child2.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("retry output");
  });

  it("throws start timeout error when both attempts time out", async () => {
    vi.useFakeTimers();
    const child1 = createMockChildProcess();
    const child2 = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const runPromise = runCodexCli(
      createRunInput({
        execution: { startTimeoutMs: 10, startRetryDelayMs: 0, runTimeoutMs: 60_000 },
      }),
    );

    // First attempt: start timeout
    vi.advanceTimersByTime(10);
    child1.emit("close", null);
    await vi.advanceTimersByTimeAsync(1);

    // Second attempt: also times out
    vi.advanceTimersByTime(10);
    child2.emit("close", null);

    await expect(runPromise).rejects.toMatchObject({
      name: "RuntimeExecutionError",
      category: "timeout",
      message: expect.stringContaining("Start timeout"),
    });
  });
});
