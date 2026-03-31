/**
 * Strip heavy text fields from task responses to reduce MCP response size.
 * Full content is still available via handoff_get_task.
 */
export function compactTaskResponse<
  T extends { plan?: unknown; implementationLog?: unknown; reviewComments?: unknown },
>(task: T) {
  const { plan, implementationLog, reviewComments, ...summary } = task;
  return {
    ...summary,
    hasPlan: !!plan,
    hasImplementationLog: !!implementationLog,
    hasReviewComments: !!reviewComments,
  };
}
