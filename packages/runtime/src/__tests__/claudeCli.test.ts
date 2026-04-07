import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";

// Mock child_process.spawn
const mockStdout = { on: vi.fn() };
const mockStderr = { on: vi.fn() };
const mockStdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
const mockChild = {
  stdout: mockStdout,
  stderr: mockStderr,
  stdin: mockStdin,
  on: vi.fn(),
  kill: vi.fn(),
};

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
    ...overrides,
  };
}

function simulateClose(code: number, stdout = "", stderr = "") {
  // Wire up stdout data
  if (stdout) {
    const dataHandler = mockStdout.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: string) => void)
      | undefined;
    dataHandler?.(stdout);
  }

  // Wire up stderr data
  if (stderr) {
    const stderrHandler = mockStderr.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: string) => void)
      | undefined;
    stderrHandler?.(stderr);
  }

  // Fire close event
  const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
    | ((code: number) => void)
    | undefined;
  closeHandler?.(code);
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

  it("spawns claude CLI with correct default args", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateClose(
      0,
      JSON.stringify({
        result: "Done",
        session_id: "sess-1",
        usage: { input_tokens: 100, output_tokens: 50 },
        cost_usd: 0.01,
      }),
    );

    const result = await promise;
    expect(result.outputText).toBe("Done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.costUsd).toBe(0.01);

    // Verify spawn args
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "-p",
        "Implement the feature",
      ]),
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });

  it("includes --agent flag when agentDefinitionName is set", async () => {
    const input = createInput({
      execution: { agentDefinitionName: "plan-coordinator" },
    });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Planned" }));

    await promise;

    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--agent");
    expect(spawnArgs[spawnArgs.indexOf("--agent") + 1]).toBe("plan-coordinator");
  });

  it("includes --model flag when model is set", async () => {
    const input = createInput({ model: "claude-opus-4-1" });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Done" }));

    await promise;

    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("claude-opus-4-1");
  });

  it("includes --resume flag for session continuation", async () => {
    const input = createInput({ resume: true, sessionId: "sess-existing" });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Resumed", session_id: "sess-existing" }));

    await promise;

    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--resume");
    expect(spawnArgs).toContain("sess-existing");
  });

  it("uses --dangerously-skip-permissions when bypassPermissions is true", async () => {
    const input = createInput({ execution: { bypassPermissions: true } });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Done" }));

    await promise;

    const spawnArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--dangerously-skip-permissions");
    expect(spawnArgs).not.toContain("acceptEdits");
  });

  it("throws classified error on non-zero exit code", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateClose(1, "", "Authentication failed");

    await expect(promise).rejects.toThrow();
  });

  it("throws classified error when JSON result has is_error: true", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Permission denied", is_error: true }));

    await expect(promise).rejects.toThrow();
  });

  it("falls back to plain text when output is not JSON", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateClose(0, "plain text output");

    const result = await promise;
    expect(result.outputText).toBe("plain text output");
  });

  it("uses custom CLI path from options", async () => {
    const input = createInput({
      options: { claudeCliPath: "/custom/bin/claude" },
    });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Done" }));

    await promise;

    expect(spawn).toHaveBeenCalledWith("/custom/bin/claude", expect.any(Array), expect.any(Object));
  });

  it("calls onStderr callback for stderr output", async () => {
    const onStderr = vi.fn();
    const input = createInput({ execution: { onStderr } });
    const promise = runClaudeCli(input);

    simulateClose(0, JSON.stringify({ result: "Done" }), "some warning");

    await promise;

    expect(onStderr).toHaveBeenCalledWith("some warning");
  });
});
