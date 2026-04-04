import { RuntimeCapabilityError } from "./errors.js";
import type { RuntimeCapabilities } from "./types.js";

export type RuntimeCapabilityName = keyof RuntimeCapabilities;

export interface RuntimeCapabilitiesLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimeCapabilityCheckInput {
  runtimeId: string;
  workflowKind?: string;
  capabilities: RuntimeCapabilities;
  required: RuntimeCapabilityName[];
  logger?: RuntimeCapabilitiesLogger;
}

export interface RuntimeCapabilityCheckResult {
  ok: boolean;
  required: RuntimeCapabilityName[];
  missing: RuntimeCapabilityName[];
}

function dedupeCapabilities(required: RuntimeCapabilityName[]): RuntimeCapabilityName[] {
  return [...new Set(required)];
}

export function checkRuntimeCapabilities(
  input: RuntimeCapabilityCheckInput,
): RuntimeCapabilityCheckResult {
  const required = dedupeCapabilities(input.required);
  if (required.length === 0) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        requiredCount: 0,
      },
      "No runtime capabilities required for workflow",
    );
    return { ok: true, required, missing: [] };
  }

  const missing = required.filter((capability) => !input.capabilities[capability]);
  const ok = missing.length === 0;

  if (!ok) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        missing,
      },
      "Runtime does not support required workflow capabilities",
    );
  } else {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        required,
      },
      "Runtime capability check passed",
    );
  }

  return { ok, required, missing };
}

export function assertRuntimeCapabilities(input: RuntimeCapabilityCheckInput): void {
  const checked = checkRuntimeCapabilities(input);
  if (checked.ok) return;

  throw new RuntimeCapabilityError(
    `Runtime "${input.runtimeId}" does not support required capabilities for workflow "${input.workflowKind ?? "unknown"}": ${checked.missing.join(", ")}`,
  );
}
