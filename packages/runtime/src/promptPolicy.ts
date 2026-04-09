import type { RuntimeCapabilities } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";
import {
  CODEX_SUBAGENT_STRATEGIES,
  getNativeSubagentWorkflowGuidance,
  resolveCodexSubagentStrategy,
} from "./adapters/codex/subagentStrategy.js";

export interface RuntimePromptPolicyLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimePromptPolicyInput {
  runtimeId: string;
  capabilities: RuntimeCapabilities;
  runtimeOptions?: Record<string, unknown>;
  workflow: RuntimeWorkflowSpec;
  logger?: RuntimePromptPolicyLogger;
}

export interface RuntimePromptPolicyResult {
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  usedFallbackSlashCommand: boolean;
  usedIsolatedSkillCommand: boolean;
  usedNativeSubagentWorkflow: boolean;
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

function prependNativeSubagentPrompt(
  workflow: RuntimeWorkflowSpec,
  prompt: string,
  agentDefinitionName: string,
): string {
  const agentReference = `Spawn the custom Codex agent "${agentDefinitionName}" and delegate this workflow to it.`;
  const workflowSpecificGuidance = getNativeSubagentWorkflowGuidance(workflow.workflowKind);

  return [
    "Use Codex native subagents for this workflow.",
    agentReference,
    "Wait for delegated work to complete before producing the final answer.",
    "Do not use slash or skill commands as the primary execution mechanism when native subagents are available.",
    workflowSpecificGuidance,
    "",
    prompt,
  ].join("\n");
}

export function resolveRuntimePromptPolicy(
  input: RuntimePromptPolicyInput,
): RuntimePromptPolicyResult {
  const canUseAgentDefinition = Boolean(
    input.workflow.agentDefinitionName && input.capabilities.supportsAgentDefinitions,
  );
  const wantsNativeSubagentWorkflow = input.workflow.executionMode === "native_subagents";
  const wantsIsolatedSkillCommand = input.workflow.executionMode === "isolated_skill_session";
  const wantsSlashFallback = input.workflow.fallbackStrategy === "slash_command";
  // Returns null for non-Codex runtimes; capability checks remain the real gate.
  const requestedCodexSubagentStrategy = resolveCodexSubagentStrategy(
    input.runtimeId,
    input.runtimeOptions,
  );
  const supportsIsolatedSkillCommand = Boolean(
    input.capabilities.supportsIsolatedSubagentWorkflows,
  );
  const supportsNativeSubagentWorkflow =
    requestedCodexSubagentStrategy !== CODEX_SUBAGENT_STRATEGIES.isolated &&
    Boolean(input.capabilities.supportsNativeSubagentWorkflows);
  const hasFallbackCommand = Boolean(input.workflow.promptInput.fallbackSlashCommand?.trim());
  const hasNativeAgentName = Boolean(input.workflow.agentDefinitionName?.trim());
  const useNativeSubagentWorkflow =
    !canUseAgentDefinition &&
    wantsNativeSubagentWorkflow &&
    supportsNativeSubagentWorkflow &&
    hasNativeAgentName;
  const useIsolatedSkillCommand =
    !canUseAgentDefinition &&
    (wantsIsolatedSkillCommand ||
      (wantsNativeSubagentWorkflow && !useNativeSubagentWorkflow && wantsSlashFallback)) &&
    supportsIsolatedSkillCommand &&
    hasFallbackCommand;
  const useSlashFallback =
    !canUseAgentDefinition &&
    wantsSlashFallback &&
    hasFallbackCommand &&
    !useNativeSubagentWorkflow &&
    !useIsolatedSkillCommand;

  if (!canUseAgentDefinition && input.workflow.agentDefinitionName) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        agentDefinitionName: input.workflow.agentDefinitionName,
        hasFallbackCommand,
      },
      "Runtime does not support agent definitions, checking workflow fallback strategy",
    );
  }
  if (wantsNativeSubagentWorkflow && !hasNativeAgentName) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but no agentDefinitionName was provided",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    requestedCodexSubagentStrategy === CODEX_SUBAGENT_STRATEGIES.isolated &&
    input.runtimeId === "codex"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Native Codex subagents disabled via runtime option; falling back to isolated skill-session execution",
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
  if (wantsNativeSubagentWorkflow && !supportsNativeSubagentWorkflow) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but runtime does not support it",
    );
  }
  if (wantsNativeSubagentWorkflow && !supportsNativeSubagentWorkflow && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution without any fallback command; prompt will remain non-delegated",
    );
  }
  if (wantsIsolatedSkillCommand && !supportsIsolatedSkillCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested isolated skill-command execution but runtime does not support it",
    );
  }

  const prompt = useNativeSubagentWorkflow
    ? prependNativeSubagentPrompt(
        input.workflow,
        input.workflow.promptInput.prompt,
        input.workflow.agentDefinitionName ?? "",
      )
    : useIsolatedSkillCommand
      ? prependSlashFallbackPrompt(
          input.workflow.promptInput.prompt,
          input.workflow.promptInput.fallbackSlashCommand ?? "",
        )
      : useSlashFallback
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
      usedIsolatedSkillCommand: useIsolatedSkillCommand,
      usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
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
    usedIsolatedSkillCommand: useIsolatedSkillCommand,
    usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
  };
}
