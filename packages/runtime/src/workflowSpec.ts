import type { RuntimeCapabilityName } from "./capabilities.js";

export type RuntimeWorkflowKind =
  | "planner"
  | "implementer"
  | "reviewer"
  | "review-security"
  | "review-gate"
  | "chat"
  | "oneshot"
  | string;

export type RuntimeWorkflowFallbackStrategy = "none" | "slash_command";

export type RuntimeSessionReusePolicy = "resume_if_available" | "new_session" | "never";
export type RuntimeWorkflowExecutionMode =
  | "standard"
  | "isolated_skill_session"
  | "native_subagents";

export interface RuntimeWorkflowPromptInput {
  prompt: string;
  fallbackSlashCommand?: string;
  systemPromptAppend?: string;
}

export interface RuntimeWorkflowSpec {
  workflowKind: RuntimeWorkflowKind;
  promptInput: RuntimeWorkflowPromptInput;
  requiredCapabilities: RuntimeCapabilityName[];
  agentDefinitionName?: string;
  fallbackStrategy: RuntimeWorkflowFallbackStrategy;
  sessionReusePolicy: RuntimeSessionReusePolicy;
  executionMode: RuntimeWorkflowExecutionMode;
  metadata?: Record<string, unknown>;
}

export interface RuntimeWorkflowSpecInput {
  workflowKind: RuntimeWorkflowKind;
  prompt: string;
  requiredCapabilities?: RuntimeCapabilityName[];
  agentDefinitionName?: string;
  fallbackSlashCommand?: string;
  fallbackStrategy?: RuntimeWorkflowFallbackStrategy;
  sessionReusePolicy?: RuntimeSessionReusePolicy;
  executionMode?: RuntimeWorkflowExecutionMode;
  systemPromptAppend?: string;
  metadata?: Record<string, unknown>;
}

export function createRuntimeWorkflowSpec(input: RuntimeWorkflowSpecInput): RuntimeWorkflowSpec {
  const requiredCapabilities = [...new Set(input.requiredCapabilities ?? [])];
  const rawFallbackStrategy =
    input.fallbackStrategy ?? (input.fallbackSlashCommand ? "slash_command" : "none");
  const requestedExecutionMode = input.executionMode ?? "standard";
  if (requestedExecutionMode === "isolated_skill_session" && !input.fallbackSlashCommand) {
    throw new Error(
      `Workflow ${input.workflowKind} requested isolated_skill_session without fallbackSlashCommand`,
    );
  }
  const executionMode: RuntimeWorkflowExecutionMode =
    requestedExecutionMode === "isolated_skill_session"
      ? "isolated_skill_session"
      : requestedExecutionMode === "native_subagents"
        ? "native_subagents"
        : "standard";
  const fallbackStrategy =
    executionMode === "isolated_skill_session" && rawFallbackStrategy === "none"
      ? "slash_command"
      : rawFallbackStrategy;

  return {
    workflowKind: input.workflowKind,
    promptInput: {
      prompt: input.prompt,
      fallbackSlashCommand: input.fallbackSlashCommand,
      systemPromptAppend: input.systemPromptAppend,
    },
    requiredCapabilities,
    agentDefinitionName: input.agentDefinitionName,
    fallbackStrategy,
    sessionReusePolicy: input.sessionReusePolicy ?? "resume_if_available",
    executionMode,
    metadata: input.metadata,
  };
}
