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

  it("runs codex cli with default args and passes prompt via stdin", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const { cliPath, cliArgs: args } = getSpawnInvocation();
    expect(cliPath).toBe("codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'approval_policy="on-request"',
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
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

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toEqual([
      "exec",
      "resume",
      "thread-abc",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'approval_policy="on-request"',
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
    expect(child.stdin.write).toHaveBeenCalledWith("Implement feature");

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

  it("emits -c approval_policy and -c sandbox_mode defaults when execution.bypassPermissions is true", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput({ execution: { bypassPermissions: true } }));

    const { cliArgs: args } = getSpawnInvocation();
    const approvalIdx = args.indexOf('approval_policy="never"');
    expect(approvalIdx).toBeGreaterThan(0);
    expect(args[approvalIdx - 1]).toBe("-c");
    const sandboxIdx = args.indexOf('sandbox_mode="danger-full-access"');
    expect(sandboxIdx).toBeGreaterThan(0);
    expect(args[sandboxIdx - 1]).toBe("-c");

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("emits stable non-bypass defaults (on-request + workspace-write) when bypassPermissions is absent", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toContain('approval_policy="on-request"');
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("lets explicit profile options.sandboxMode override the bypass default", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(
      createRunInput({
        execution: { bypassPermissions: true },
        options: { sandboxMode: "workspace-write" },
      }),
    );

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toContain('approval_policy="never"'); // bypass still applies to approval
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).not.toContain('sandbox_mode="danger-full-access"');

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("reads options.approvalPolicy override while keeping sandbox at non-bypass default", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(
      createRunInput({
        options: { approvalPolicy: "on-failure" },
      }),
    );

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toContain('approval_policy="on-failure"');
    // Sandbox was not explicitly set → stable non-bypass default kicks in
    expect(args).toContain('sandbox_mode="workspace-write"');

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("custom codexCliArgs is a full escape hatch — adapter-managed flags are NOT injected", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(
      createRunInput({
        execution: { bypassPermissions: true },
        options: {
          codexCliArgs: ["run", "--json", "--prompt={prompt}"],
        },
      }),
    );

    const { cliArgs: args } = getSpawnInvocation();
    expect(args.some((arg) => arg.startsWith("approval_policy="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("sandbox_mode="))).toBe(false);
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toEqual(["run", "--json", "--prompt=Implement feature"]);

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
  });

  it("appends --skip-git-repo-check when options.skipGitRepoCheck is true", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput({ options: { skipGitRepoCheck: true } }));

    const { cliArgs: args } = getSpawnInvocation();
    expect(args).toContain("--skip-git-repo-check");

    child.stdout.emit("data", "ok");
    child.emit("close", 0);
    await runPromise;
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

  it("captures thread_id, accumulates agent_message text, and fires stream:text events", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const onEvent = vi.fn();
    const runPromise = runCodexCli(createRunInput({ execution: { onEvent } }));

    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "thread.started",
        thread_id: "019d76a3-f039-7472-81de-7ffb0759542c",
      }) + "\n",
    );
    child.stdout.emit("data", JSON.stringify({ type: "turn.started" }) + "\n");
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Hello " },
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "world" },
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 },
      }) + "\n",
    );
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.sessionId).toBe("019d76a3-f039-7472-81de-7ffb0759542c");
    expect(result.outputText).toBe("Hello \n\nworld");
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
    });

    const streamTextEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; message?: string })
      .filter((e) => e.type === "stream:text");
    expect(streamTextEvents).toHaveLength(2);
    expect(streamTextEvents[0]?.message).toBe("Hello ");
    expect(streamTextEvents[1]?.message).toBe("world");

    const initEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "system:init");
    expect(initEvents).toHaveLength(1);
  });

  it("emits tool:use and calls onToolUse for command_execution items", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    const runPromise = runCodexCli(createRunInput({ execution: { onToolUse, onEvent } }));

    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread-tool-1",
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/zsh -lc ls",
          status: "in_progress",
        },
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/zsh -lc ls",
          aggregated_output: "file1\nfile2",
          exit_code: 0,
          status: "completed",
        },
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "Listed files." },
      }) + "\n",
    );
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10 },
      }) + "\n",
    );
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("Listed files.");

    // Tool use triggered once on item.started, NOT re-emitted on item.completed
    expect(onToolUse).toHaveBeenCalledTimes(1);
    const [toolName, detail] = onToolUse.mock.calls[0];
    expect(toolName).toBe("Bash");
    expect(detail).toContain("ls");

    const toolEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; data?: { name?: string } })
      .filter((e) => e.type === "tool:use");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.data?.name).toBe("Bash");
  });

  it("handles JSONL lines split across multiple stdout chunks", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());

    // Split a single JSON line across two chunks to exercise the line buffer
    const line1 = JSON.stringify({
      type: "thread.started",
      thread_id: "thread-split",
    });
    child.stdout.emit("data", line1.slice(0, 20));
    child.stdout.emit("data", line1.slice(20) + "\n");
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "ok" },
      }) + "\n",
    );
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.sessionId).toBe("thread-split");
    expect(result.outputText).toBe("ok");
  });

  it("falls back to plain text when stdout is not JSONL", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const runPromise = runCodexCli(createRunInput());
    child.stdout.emit("data", "not json at all");
    child.emit("close", 0);

    const result = await runPromise;
    expect(result.outputText).toBe("not json at all");
    expect(result.raw).toBe("not json at all");
  });
});
