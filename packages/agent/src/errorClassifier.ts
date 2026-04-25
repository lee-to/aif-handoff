/**
 * Error classification for coordinator pipeline.
 *
 * Uses structured RuntimeExecutionError.category from @aif/runtime as the
 * primary classification signal. String-based pattern matching is used only
 * for non-RuntimeExecutionError errors (e.g., RuntimeCapabilityError).
 */

import { RuntimeExecutionError, isExternalFailureCategory } from "@aif/runtime";
import { BranchIsolationError } from "./gitBranch.js";

export function findBranchIsolationError(err: unknown): BranchIsolationError | null {
  if (err instanceof BranchIsolationError) return err;
  if (err instanceof Error && "cause" in err && err.cause) {
    return findBranchIsolationError(err.cause);
  }
  return null;
}

/** Capability errors surface as RuntimeCapabilityError with these message fragments. */
const CAPABILITY_FAILURE_PATTERNS = [
  "runtime capability",
  "required capabilities",
  "unsupported capabilities",
];

const FAST_RETRY_PATTERNS: Array<(lower: string) => boolean> = [
  (lower) => lower.includes("stream interrupted before implement-worker dispatch"),
  (lower) => lower.includes("error in hook callback") && lower.includes("stream closed"),
];

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

export function findRuntimeExecutionError(err: unknown): RuntimeExecutionError | null {
  if (err instanceof RuntimeExecutionError) {
    return err;
  }
  if (err instanceof Error && "cause" in err && err.cause) {
    return findRuntimeExecutionError(err.cause);
  }
  return null;
}

export function isExternalFailure(err: unknown): boolean {
  // Primary: structured category from runtime adapter classification
  const runtimeError = findRuntimeExecutionError(err);
  if (runtimeError) {
    return isExternalFailureCategory(runtimeError.category);
  }

  // Secondary: capability errors (RuntimeCapabilityError, not RuntimeExecutionError)
  const lower = errorText(err);
  return CAPABILITY_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function isFastRetryableFailure(err: unknown): boolean {
  const lower = errorText(err);
  return FAST_RETRY_PATTERNS.some((check) => check(lower));
}

export function truncateReason(reason: string, maxLength = 240): string {
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength - 3)}...`;
}
