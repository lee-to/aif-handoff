import type { RuntimeCapabilities } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";

export interface RuntimePromptPolicyLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimePromptPolicyInput {
  runtimeId: string;
  capabilities: RuntimeCapabilities;
  workflow: RuntimeWorkflowSpec;
  logger?: RuntimePromptPolicyLogger;
}

export interface RuntimePromptPolicyResult {
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  usedFallbackSlashCommand: boolean;
}

const DEFAULT_SKILL_PREFIX = "/";

/**
 * Pattern matching skill command invocations in prompts.
 * Matches "/aif-<name>" at word boundaries (start of line or after whitespace).
 * The pattern captures the "/" prefix so it can be replaced with the runtime-specific prefix.
 */
const SKILL_COMMAND_PATTERN = /(?<=^|\s)\/(?=aif-)/gm;

/**
 * Transform skill command prefixes in text from the default "/" to the runtime-specific prefix.
 * Only transforms when the target prefix differs from the default.
 */
export function transformSkillCommandPrefix(text: string, prefix: string): string {
  if (!prefix || prefix === DEFAULT_SKILL_PREFIX) return text;
  return text.replace(SKILL_COMMAND_PATTERN, prefix);
}

function prependSlashFallbackPrompt(prompt: string, fallbackSlashCommand: string): string {
  const trimmedCommand = fallbackSlashCommand.trim();
  if (!trimmedCommand) return prompt;

  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.startsWith(trimmedCommand)) return prompt;
  return `${trimmedCommand}\n\n${prompt}`;
}

export function resolveRuntimePromptPolicy(
  input: RuntimePromptPolicyInput,
): RuntimePromptPolicyResult {
  const canUseAgentDefinition = Boolean(
    input.workflow.agentDefinitionName && input.capabilities.supportsAgentDefinitions,
  );
  const wantsSlashFallback = input.workflow.fallbackStrategy === "slash_command";
  const hasFallbackCommand = Boolean(input.workflow.promptInput.fallbackSlashCommand?.trim());
  const useSlashFallback = !canUseAgentDefinition && wantsSlashFallback && hasFallbackCommand;

  if (!canUseAgentDefinition && input.workflow.agentDefinitionName) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        agentDefinitionName: input.workflow.agentDefinitionName,
        hasFallbackCommand,
      },
      "Runtime does not support agent definitions, checking workflow fallback strategy",
    );
  }

  if (wantsSlashFallback && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested slash fallback but no fallback slash command was provided",
    );
  }

  const prompt = useSlashFallback
    ? prependSlashFallbackPrompt(
        input.workflow.promptInput.prompt,
        input.workflow.promptInput.fallbackSlashCommand ?? "",
      )
    : input.workflow.promptInput.prompt;
  const systemPromptAppend = input.workflow.promptInput.systemPromptAppend ?? "";
  const agentDefinitionName = canUseAgentDefinition
    ? input.workflow.agentDefinitionName
    : undefined;

  input.logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      workflowKind: input.workflow.workflowKind,
      usedFallbackSlashCommand: useSlashFallback,
      agentDefinitionName: agentDefinitionName ?? null,
      systemPromptAppendLength: systemPromptAppend.length,
    },
    "Resolved runtime workflow prompt policy",
  );

  return {
    prompt,
    systemPromptAppend,
    agentDefinitionName,
    usedFallbackSlashCommand: useSlashFallback,
  };
}
