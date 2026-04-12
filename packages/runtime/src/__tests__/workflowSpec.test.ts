import { describe, expect, it } from "vitest";
import {
  createRuntimeWorkflowSpec,
  resolveRuntimePromptPolicy,
  transformSkillCommandPrefix,
  UsageReporting,
  type RuntimeCapabilities,
} from "../index.js";

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: false,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
  supportsIsolatedSubagentWorkflows: true,
  supportsNativeSubagentWorkflows: true,
  usageReporting: UsageReporting.NONE,
};

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  usageReporting: UsageReporting.FULL,
};

describe("runtime workflow spec + prompt policy", () => {
  it("falls back to slash command when agent definitions are unavailable", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt: "Plan this feature",
      agentDefinitionName: "plan-coordinator",
      fallbackSlashCommand: "/aif-plan fast",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("/aif-plan fast");
  });

  it("keeps agent definition when runtime supports it", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "claude",
      capabilities: CLAUDE_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBe("implement-coordinator");
    expect(resolved.prompt).toBe("Implement this feature");
  });

  it("uses isolated skill-command mode when runtime supports isolated subagent workflows", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "isolated_skill_session",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("uses native Codex subagents when runtime supports them", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "native" },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(true);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("Use Codex native subagents for this workflow.");
    expect(resolved.prompt).toContain('Spawn the custom Codex agent "implement-coordinator"');
    expect(resolved.prompt).not.toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("falls back to isolated skill-command mode when native Codex subagents are disabled by runtime option", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "isolated" },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("defaults Codex native_subagents requests to native orchestration when no strategy override is set", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: {},
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(true);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.prompt).toContain('Spawn the custom Codex agent "implement-coordinator"');
  });

  it("keeps Claude native agent-definition behavior unchanged when Codex strategy options are present", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "claude",
      capabilities: CLAUDE_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "isolated" },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBe("implement-coordinator");
    expect(resolved.prompt).toBe("Implement this feature");
  });

  it("downgrades isolated skill-command mode to slash fallback when runtime lacks capability", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "isolated_skill_session",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      capabilities: {
        ...CODEX_CAPABILITIES,
        supportsIsolatedSubagentWorkflows: false,
      },
      workflow,
    });

    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("downgrades native Codex subagents to slash fallback when neither native nor isolated execution is available", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      capabilities: {
        ...CODEX_CAPABILITIES,
        supportsIsolatedSubagentWorkflows: false,
        supportsNativeSubagentWorkflows: false,
      },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("throws when isolated skill-command mode is requested without a fallback command", () => {
    expect(() =>
      createRuntimeWorkflowSpec({
        workflowKind: "implementer",
        prompt: "Implement this feature",
        executionMode: "isolated_skill_session",
      }),
    ).toThrow(/isolated_skill_session without fallbackSlashCommand/i);
  });

  it("defaults fallbackStrategy to slash_command when slash command is provided", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "reviewer",
      prompt: "Review this task",
      fallbackSlashCommand: "/aif-review",
      requiredCapabilities: ["supportsApprovals", "supportsApprovals"],
    });

    expect(workflow.fallbackStrategy).toBe("slash_command");
    expect(workflow.requiredCapabilities).toEqual(["supportsApprovals"]);
    expect(workflow.sessionReusePolicy).toBe("resume_if_available");
  });

  it("defaults fallbackStrategy to none when no slash command is provided", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "oneshot",
      prompt: "Generate commit message",
      sessionReusePolicy: "new_session",
    });

    expect(workflow.fallbackStrategy).toBe("none");
    expect(workflow.promptInput.fallbackSlashCommand).toBeUndefined();
    expect(workflow.sessionReusePolicy).toBe("new_session");
  });
});

describe("transformSkillCommandPrefix", () => {
  it("transforms /aif-plan to $aif-plan", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "$")).toBe("$aif-plan fast");
  });

  it("transforms multiple skill commands in one prompt", () => {
    const input = "/aif-review\n\nAlso run /aif-security-checklist after review";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toContain("$aif-review");
    expect(result).toContain("$aif-security-checklist");
    expect(result).not.toContain("/aif-review");
    expect(result).not.toContain("/aif-security-checklist");
  });

  it("does not transform non-skill slash patterns", () => {
    const input = "Check /etc/config and /usr/local/bin paths\n/aif-implement @PLAN.md";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toContain("/etc/config");
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("$aif-implement");
    expect(result).not.toContain("/aif-implement");
  });

  it("returns text unchanged when prefix is /", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "/")).toBe("/aif-plan fast");
  });

  it("returns text unchanged when prefix is empty", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "")).toBe("/aif-plan fast");
  });

  it("transforms /aif-fix command", () => {
    const result = transformSkillCommandPrefix('/aif-fix --plan-first "Title: bug"', "$");
    expect(result).toContain("$aif-fix --plan-first");
    expect(result).not.toContain("/aif-fix");
  });

  it("transforms inline skill references after whitespace", () => {
    const input = "Plan using /aif-plan approach and /aif-commit after";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toBe("Plan using $aif-plan approach and $aif-commit after");
  });
});
