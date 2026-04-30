import { RuntimeCapabilityError } from "./errors.js";
import type { RuntimeCapabilities, RuntimeTransport } from "./types.js";

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

export type RuntimeSessionForkSkipReason = "unsupported_capability" | "missing_adapter_method";

export interface RuntimeSessionForkSupportInput {
  runtimeId: string;
  transport?: RuntimeTransport | string | null;
  capabilities: RuntimeCapabilities;
  hasForkSessionMethod: boolean;
  sourceSessionId?: string | null;
  logger?: RuntimeCapabilitiesLogger;
}

export interface RuntimeSessionForkSupportResult {
  ok: boolean;
  skipReason?: RuntimeSessionForkSkipReason;
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

export function checkRuntimeSessionForkSupport(
  input: RuntimeSessionForkSupportInput,
): RuntimeSessionForkSupportResult {
  const skipReason: RuntimeSessionForkSkipReason | null = !input.capabilities.supportsSessionFork
    ? "unsupported_capability"
    : !input.hasForkSessionMethod
      ? "missing_adapter_method"
      : null;

  if (!skipReason) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        transport: input.transport ?? null,
        hasSourceSessionId: Boolean(input.sourceSessionId),
      },
      "Runtime session fork support check passed",
    );
    return { ok: true };
  }

  input.logger?.warn?.(
    {
      runtimeId: input.runtimeId,
      transport: input.transport ?? null,
      hasSourceSessionId: Boolean(input.sourceSessionId),
      skipReason,
    },
    "Runtime session fork requested but unavailable",
  );

  return { ok: false, skipReason };
}
