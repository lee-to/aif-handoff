interface CodexPermissionLogger {
  warn?(context: Record<string, unknown>, message: string): void;
}

const CODEX_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const);

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export function normalizeCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODEX_APPROVAL_POLICIES.has(trimmed as CodexApprovalPolicy)
    ? (trimmed as CodexApprovalPolicy)
    : null;
}

const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const);

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export function normalizeCodexSandboxMode(value: unknown): CodexSandboxMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODEX_SANDBOX_MODES.has(trimmed as CodexSandboxMode)
    ? (trimmed as CodexSandboxMode)
    : null;
}

export function warnOnInvalidCodexPermissionOverride(input: {
  logger?: CodexPermissionLogger;
  runtimeId: string;
  transport: "cli" | "sdk";
  field: "approvalPolicy" | "sandboxMode";
  rawValue: string | null;
  normalizedValue: string | null;
  source?: "options" | "hooks";
}): void {
  if (!input.rawValue || input.normalizedValue) {
    return;
  }

  input.logger?.warn?.(
    {
      runtimeId: input.runtimeId,
      transport: input.transport,
      field: input.field,
      invalidValue: input.rawValue,
      ...(input.source ? { source: input.source } : {}),
    },
    `Ignoring invalid Codex ${input.field} override`,
  );
}
