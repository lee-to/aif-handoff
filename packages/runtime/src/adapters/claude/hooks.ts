import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeSubagentStartCallback, RuntimeToolUseCallback } from "../../types.js";

export interface ClaudeHookOptions {
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
  onToolUse?: RuntimeToolUseCallback;
  onSubagentStart?: RuntimeSubagentStartCallback;
}

export interface ClaudeHooksPayload {
  PostToolUse?: Array<{ hooks: HookCallback[] }>;
  SubagentStart?: Array<{ hooks: HookCallback[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";
  switch (toolName) {
    case "Bash": {
      const cmd = String(toolInput.command ?? "")
        .trim()
        .slice(0, 200);
      return cmd ? ` \`${cmd}\`` : "";
    }
    case "Read":
    case "Write":
    case "Edit":
      return toolInput.file_path ? ` ${toolInput.file_path}` : "";
    case "Glob":
      return toolInput.pattern ? ` ${toolInput.pattern}` : "";
    case "Grep":
      return toolInput.pattern ? ` /${toolInput.pattern}/` : "";
    case "Agent": {
      const desc = toolInput.description ?? toolInput.subagent_type ?? "";
      return desc ? ` ${desc}` : "";
    }
    default:
      return "";
  }
}

/** Wrap a generic onToolUse callback into a Claude SDK PostToolUse HookCallback. */
function bridgeToolUseHook(onToolUse: RuntimeToolUseCallback): HookCallback {
  return async (input) => {
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    const toolName = String(data.tool_name ?? "unknown");
    const toolInput = isRecord(data.tool_input) ? data.tool_input : undefined;
    onToolUse(toolName, summarizeToolInput(toolName, toolInput));
    return {};
  };
}

/** Wrap a generic onSubagentStart callback into a Claude SDK SubagentStart HookCallback. */
function bridgeSubagentStartHook(onSubagentStart: RuntimeSubagentStartCallback): HookCallback {
  return async (input) => {
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    // SDK sends agent_type (e.g. "plan-coordinator") and agent_id
    const name = String(
      data.agent_type ?? data.agent_name ?? data.subagent_type ?? data.description ?? "unknown",
    );
    const id = String(data.agent_id ?? data.session_id ?? "");
    onSubagentStart(name, id);
    return {};
  };
}

export function buildClaudeHooks(options: ClaudeHookOptions): ClaudeHooksPayload | undefined {
  const postToolUseHooks = [...(options.postToolUseHooks ?? [])];
  const subagentStartHooks = [...(options.subagentStartHooks ?? [])];

  if (options.onToolUse) {
    postToolUseHooks.push(bridgeToolUseHook(options.onToolUse));
  }
  if (options.onSubagentStart) {
    subagentStartHooks.push(bridgeSubagentStartHook(options.onSubagentStart));
  }

  const hooks: ClaudeHooksPayload = {};
  if (postToolUseHooks.length > 0) {
    hooks.PostToolUse = [{ hooks: postToolUseHooks }];
  }
  if (subagentStartHooks.length > 0) {
    hooks.SubagentStart = [{ hooks: subagentStartHooks }];
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
