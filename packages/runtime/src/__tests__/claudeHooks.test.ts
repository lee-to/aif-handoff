import { describe, expect, it, vi } from "vitest";
import { buildClaudeHooks } from "../adapters/claude/hooks.js";

/** Call a hook with loose input (tests pass raw objects, SDK types are strict). */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const call = (hook: Function, input: unknown) => hook(input, undefined, undefined);

describe("buildClaudeHooks", () => {
  it("returns undefined when no hooks provided", () => {
    expect(buildClaudeHooks({})).toBeUndefined();
  });

  it("wraps postToolUseHooks into PostToolUse array", () => {
    const hook = vi.fn().mockReturnValue({});
    const result = buildClaudeHooks({ postToolUseHooks: [hook] });

    expect(result?.PostToolUse).toHaveLength(1);
    expect(result?.PostToolUse?.[0].hooks).toContain(hook);
  });

  it("wraps subagentStartHooks into SubagentStart array", () => {
    const hook = vi.fn().mockReturnValue({});
    const result = buildClaudeHooks({ subagentStartHooks: [hook] });

    expect(result?.SubagentStart).toHaveLength(1);
    expect(result?.SubagentStart?.[0].hooks).toContain(hook);
  });

  it("bridges onToolUse callback into PostToolUse hook", async () => {
    const onToolUse = vi.fn();
    const result = buildClaudeHooks({ onToolUse });

    expect(result?.PostToolUse).toHaveLength(1);

    // Call the bridge hook with Claude SDK-shaped input
    const bridgeHook = result!.PostToolUse![0].hooks[0];
    await call(bridgeHook, { tool_name: "Bash", tool_input: { command: "ls -la" } });

    expect(onToolUse).toHaveBeenCalledWith("Bash", expect.stringContaining("ls -la"));
  });

  it("bridges onSubagentStart callback into SubagentStart hook", async () => {
    const onSubagentStart = vi.fn();
    const result = buildClaudeHooks({ onSubagentStart });

    expect(result?.SubagentStart).toHaveLength(1);

    const bridgeHook = result!.SubagentStart![0].hooks[0];
    await call(bridgeHook, { agent_name: "implement-worker", agent_id: "abcdef1234" });

    expect(onSubagentStart).toHaveBeenCalledWith("implement-worker", "abcdef1234");
  });

  it("combines native hooks with bridge hooks", async () => {
    const nativeHook = vi.fn().mockReturnValue({});
    const onToolUse = vi.fn();
    const result = buildClaudeHooks({
      postToolUseHooks: [nativeHook],
      onToolUse,
    });

    expect(result?.PostToolUse?.[0].hooks).toHaveLength(2);
    expect(result?.PostToolUse?.[0].hooks[0]).toBe(nativeHook);
  });

  it("bridge handles non-object input gracefully", async () => {
    const onToolUse = vi.fn();
    const result = buildClaudeHooks({ onToolUse });
    const bridgeHook = result!.PostToolUse![0].hooks[0];

    await call(bridgeHook, null);
    await call(bridgeHook, "string");
    await call(bridgeHook, 42);

    expect(onToolUse).not.toHaveBeenCalled();
  });

  it("summarizes tool input for known tools", async () => {
    const onToolUse = vi.fn();
    const result = buildClaudeHooks({ onToolUse });
    const bridgeHook = result!.PostToolUse![0].hooks[0];

    await call(bridgeHook, { tool_name: "Read", tool_input: { file_path: "/src/index.ts" } });
    expect(onToolUse).toHaveBeenCalledWith("Read", " /src/index.ts");

    await call(bridgeHook, { tool_name: "Grep", tool_input: { pattern: "TODO" } });
    expect(onToolUse).toHaveBeenCalledWith("Grep", " /TODO/");

    await call(bridgeHook, { tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
    expect(onToolUse).toHaveBeenCalledWith("Glob", " **/*.ts");

    await call(bridgeHook, { tool_name: "Agent", tool_input: { description: "search code" } });
    expect(onToolUse).toHaveBeenCalledWith("Agent", " search code");
  });

  it("subagent bridge extracts name from various fields", async () => {
    const onSubagentStart = vi.fn();
    const result = buildClaudeHooks({ onSubagentStart });
    const bridgeHook = result!.SubagentStart![0].hooks[0];

    await call(bridgeHook, { subagent_type: "plan-polisher" });
    expect(onSubagentStart).toHaveBeenCalledWith("plan-polisher", "");

    await call(bridgeHook, { description: "analyze code" });
    expect(onSubagentStart).toHaveBeenCalledWith("analyze code", "");

    await call(bridgeHook, { agent_name: "worker", session_id: "xyz123" });
    expect(onSubagentStart).toHaveBeenCalledWith("worker", "xyz123");
  });
});
