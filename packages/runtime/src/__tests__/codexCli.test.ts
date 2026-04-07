import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    metadata: {},
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

  it("runs codex cli with default args and writes prompt to stdin", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cliPath, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cliPath).toBe("codex");
    expect(args).toEqual(["exec", "--json", "--model", "gpt-5.4"]);
    expect(child.stdin.write).toHaveBeenCalledWith("Implement feature");

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

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(["exec", "resume", "thread-abc", "--json", "--model", "gpt-5.4"]);

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

    const [cliPath, args, spawnOptions] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
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

  it("kills process and throws timeout error when run exceeds timeout", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(
      createRunInput({
        metadata: { timeoutMs: 5 },
      }),
    );

    vi.advanceTimersByTime(5);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 0);

    await expect(runPromise).rejects.toMatchObject({
      name: "CodexRuntimeAdapterError",
      adapterCode: "CODEX_TIMEOUT",
    });
  });
});
