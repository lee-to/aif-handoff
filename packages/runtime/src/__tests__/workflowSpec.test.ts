import { describe, expect, it } from "vitest";
import { createRuntimeWorkflowSpec, resolveRuntimePromptPolicy } from "../index.js";

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
      capabilities: {
        supportsResume: true,
        supportsSessionList: false,
        supportsAgentDefinitions: false,
        supportsStreaming: true,
        supportsModelDiscovery: false,
        supportsApprovals: true,
        supportsCustomEndpoint: true,
      },
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
      capabilities: {
        supportsResume: true,
        supportsSessionList: true,
        supportsAgentDefinitions: true,
        supportsStreaming: true,
        supportsModelDiscovery: true,
        supportsApprovals: true,
        supportsCustomEndpoint: true,
      },
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
