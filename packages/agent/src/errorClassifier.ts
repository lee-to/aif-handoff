/**
 * Error classification for coordinator pipeline.
 * Extensible via EXTERNAL_FAILURE_PATTERNS and FAST_RETRY_PATTERNS.
 */

const EXTERNAL_FAILURE_PATTERNS: string[] = [
  "not logged in",
  "usage limit",
  "extra usage",
  "out of extra usage",
  "rate limit",
  "quota",
  "credits",
  "exited with code 1",
  "timed out",
  "stream interrupted",
  "stream closed",
  "error in hook callback",
  "permission denied",
  "blocked by permissions",
  "write permission",
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

export function isExternalFailure(err: unknown): boolean {
  const lower = errorText(err);
  return EXTERNAL_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function isFastRetryableFailure(err: unknown): boolean {
  const lower = errorText(err);
  return FAST_RETRY_PATTERNS.some((check) => check(lower));
}

export function truncateReason(reason: string, maxLength = 240): string {
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength - 3)}...`;
}
