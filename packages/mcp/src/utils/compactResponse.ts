/**
 * Strip heavy text fields from task responses to reduce MCP response size.
 * Full content is still available via handoff_get_task.
 */
export function compactTaskResponse<
  T extends { plan?: unknown; implementationLog?: unknown; reviewComments?: unknown },
>(task: T) {
  const { plan, implementationLog, reviewComments, ...summary } = task;
  const sensitiveFields = new Set([
    "password",
    "passwordHash",
    "csrfToken",
    "sessionToken",
    "tokenDigest",
    "csrfTokenDigest",
    "cookie",
  ]);
  const sanitized = Object.fromEntries(
    Object.entries(summary).filter(([field]) => !sensitiveFields.has(field)),
  ) as Omit<T, "plan" | "implementationLog" | "reviewComments">;
  return {
    ...sanitized,
    hasPlan: !!plan,
    hasImplementationLog: !!implementationLog,
    hasReviewComments: !!reviewComments,
  };
}
