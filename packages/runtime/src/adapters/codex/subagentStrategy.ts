import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeWorkflowKind } from "../../workflowSpec.js";
import { asRecord, readString } from "../../utils.js";

export const CODEX_SUBAGENT_STRATEGY_OPTION = "codexSubagentStrategy";

export const CODEX_SUBAGENT_STRATEGIES = {
  native: "native",
  isolated: "isolated",
} as const;

export type CodexSubagentStrategy =
  (typeof CODEX_SUBAGENT_STRATEGIES)[keyof typeof CODEX_SUBAGENT_STRATEGIES];

const CODEX_NATIVE_AGENT_FILES = [
  "best-practices-sidecar.toml",
  "commit-preparer.toml",
  "docs-auditor.toml",
  "implement-coordinator.toml",
  "implement-worker.toml",
  "plan-coordinator.toml",
  "plan-polisher.toml",
  "review-sidecar.toml",
  "security-sidecar.toml",
] as const;

export interface CodexNativeSubagentReadiness {
  ready: boolean;
  missingPaths: string[];
}

export function resolveCodexSubagentStrategy(
  runtimeId: string,
  runtimeOptions?: Record<string, unknown>,
): CodexSubagentStrategy | null {
  if (runtimeId !== "codex") return null;
  const configured = readString(asRecord(runtimeOptions)[CODEX_SUBAGENT_STRATEGY_OPTION]);
  return configured === CODEX_SUBAGENT_STRATEGIES.isolated
    ? CODEX_SUBAGENT_STRATEGIES.isolated
    : CODEX_SUBAGENT_STRATEGIES.native;
}

export function resolveCodexNativeSubagentReadiness(
  projectRoot?: string | null,
): CodexNativeSubagentReadiness {
  if (!projectRoot) {
    return {
      ready: false,
      missingPaths: [".codex/config.toml", ".codex/agents/*.toml"],
    };
  }

  const missingPaths = [
    ...CODEX_NATIVE_AGENT_FILES.filter(
      (fileName) => !existsSync(join(projectRoot, ".codex", "agents", fileName)),
    ).map((fileName) => `.codex/agents/${fileName}`),
  ];

  if (!existsSync(join(projectRoot, ".codex", "config.toml"))) {
    missingPaths.push(".codex/config.toml");
  }

  return {
    ready: missingPaths.length === 0,
    missingPaths,
  };
}

const NATIVE_SUBAGENT_WORKFLOW_GUIDANCE: Partial<Record<RuntimeWorkflowKind, string>> = {
  planner:
    'Use "plan-polisher" for bounded critique/refinement passes when helpful, then return the final implementation-ready plan in the parent thread.',
  implementer:
    'Let the coordinator agent decide when to spawn "implement-worker", "review-sidecar", "security-sidecar", "best-practices-sidecar", "docs-auditor", and "commit-preparer". Reconcile results in the parent thread.',
  reviewer: 'Return only the consolidated findings from the delegated "review-sidecar" run.',
  "review-security":
    'Return only the consolidated findings from the delegated "security-sidecar" run.',
};

export function getNativeSubagentWorkflowGuidance(workflowKind: RuntimeWorkflowKind): string {
  return (
    NATIVE_SUBAGENT_WORKFLOW_GUIDANCE[workflowKind] ??
    "Delegate work to the named custom agent and keep the final response in the parent thread."
  );
}
