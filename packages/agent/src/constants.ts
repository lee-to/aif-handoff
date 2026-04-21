/**
 * Shared constants for the agent package.
 */

export const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

/**
 * Scope rule injected automatically into review-style subagent queries
 * (profileMode === "review"). Keeps review/security sidecars focused on the
 * current task's diff instead of auditing unrelated code paths.
 */
export const REVIEW_DIFF_SCOPE_SYSTEM_APPEND =
  "Review scope rule: review ONLY code that changed as part of this task's implementation " +
  "(the diff introduced by the current plan's tasks). Do NOT audit unrelated files, " +
  "pre-existing code paths, or broader project concerns. If a concern is outside the changed " +
  'scope, note it briefly as "out of scope" and move on. Reference changed files/lines ' +
  "explicitly. Ignore pre-existing issues unless they are directly aggravated by the change. " +
  "Your job is to validate the delta, not the whole codebase.";
