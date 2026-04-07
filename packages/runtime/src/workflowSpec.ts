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
  systemPromptAppend?: string;
  metadata?: Record<string, unknown>;
}

export function createRuntimeWorkflowSpec(input: RuntimeWorkflowSpecInput): RuntimeWorkflowSpec {
  const requiredCapabilities = [...new Set(input.requiredCapabilities ?? [])];
  const fallbackStrategy =
    input.fallbackStrategy ?? (input.fallbackSlashCommand ? "slash_command" : "none");

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
    metadata: input.metadata,
  };
}
