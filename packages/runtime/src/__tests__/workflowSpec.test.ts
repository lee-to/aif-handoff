import { describe, expect, it } from "vitest";
import {
  createRuntimeWorkflowSpec,
  resolveRuntimePromptPolicy,
  transformSkillCommandPrefix,
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
};

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
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
