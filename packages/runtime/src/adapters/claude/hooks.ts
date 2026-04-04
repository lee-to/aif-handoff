import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeHookOptions {
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
}

export interface ClaudeHooksPayload {
  PostToolUse?: Array<{ hooks: HookCallback[] }>;
  SubagentStart?: Array<{ hooks: HookCallback[] }>;
}

export function buildClaudeHooks(options: ClaudeHookOptions): ClaudeHooksPayload | undefined {
  const postToolUseHooks = options.postToolUseHooks ?? [];
  const subagentStartHooks = options.subagentStartHooks ?? [];

  const hooks: ClaudeHooksPayload = {};
  if (postToolUseHooks.length > 0) {
    hooks.PostToolUse = [{ hooks: postToolUseHooks }];
  }
  if (subagentStartHooks.length > 0) {
    hooks.SubagentStart = [{ hooks: subagentStartHooks }];
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
