import {
  assertCurrentBranch,
  ensureFeatureBranch,
  getProjectConfig,
  isBranchIsolationError,
  logger,
} from "@aif/shared";
import { findProjectById, findTaskById } from "@aif/data";
import { UsageSource } from "@aif/runtime";
import { runApiRuntimeOneShot } from "./runtime.js";

const log = logger("commit-generation");

const PROJECT_SCOPE_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

export interface RunCommitQueryResult {
  ok: boolean;
  error?: string;
}

export interface RunCommitQueryInput {
  projectId: string;
  taskId?: string | null;
}

/**
 * Build the explicit instruction prompt for the commit run.
 *
 * Background: the previous implementation sent the bare string `"/aif-commit"`
 * as the prompt, relying on Claude Code to resolve it as a slash command /
 * skill. In `-p` (print) mode that resolution is unreliable — the model would
 * often respond with text and never actually run `git commit`. This prompt
 * spells the full procedure out in English so ANY runtime adapter can execute
 * it. We still pass the slash command as a fallback hint for adapters that DO
 * support skill resolution.
 */
export function buildCommitPrompt(shouldPush: boolean): string {
  const pushLine = shouldPush
    ? "5. After committing, run `git push` on the current branch. Do not force-push."
    : "5. Do NOT push. The project is configured with `git.skip_push_after_commit: true` — commit only.";

  return [
    "You are running the aif-commit workflow. Follow these steps exactly:",
    "",
    "1. Run `git status` to see the current working tree.",
    "2. Stage ALL changes, including untracked files: run `git add -A` from the project root.",
    "3. Analyze the staged diff (`git diff --cached`) and draft ONE conventional commit message (feat/fix/chore/docs/refactor/test/perf, optional scope, short subject, body if helpful).",
    "4. Create the commit with `git commit -m ...`. Create exactly one commit. Do not amend.",
    pushLine,
    "",
    "Hard rules:",
    "- Never skip git hooks (no --no-verify).",
    "- Never rewrite history (no rebase, no reset --hard, no amend).",
    "- Never add the `Co-Authored-By` trailer.",
    "- If there are no changes to commit after `git add -A`, report that and stop — do NOT create an empty commit.",
  ].join("\n");
}

/**
 * Fire-and-forget entry point: run the commit workflow via the shared runtime
 * in the project root. Returns a structured result so the caller can broadcast
 * success/failure over WS. Never throws.
 */
export async function runCommitQuery(input: RunCommitQueryInput): Promise<RunCommitQueryResult> {
  const { projectId, taskId = null } = input;
  const project = findProjectById(projectId);
  if (!project) {
    const msg = `Project not found: ${projectId}`;
    log.error({ projectId }, msg);
    return { ok: false, error: msg };
  }

  const task = taskId ? findTaskById(taskId) : null;
  if (task?.branchName && !task.isFix) {
    try {
      ensureFeatureBranch({
        projectRoot: project.rootPath,
        taskId: task.id,
        title: task.title,
        explicitBranchName: task.branchName,
        switchOnly: true,
      });
    } catch (err) {
      const message = isBranchIsolationError(err)
        ? `Branch isolation failure (${err.kind}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      log.error(
        { err, projectId, taskId, branchName: task.branchName },
        "Commit runtime aborted before start due to branch isolation failure",
      );
      return { ok: false, error: message };
    }
  }

  const { git } = getProjectConfig(project.rootPath);
  const shouldPush = git.enabled && !git.skip_push_after_commit;
  const prompt = buildCommitPrompt(shouldPush);

  log.info(
    {
      projectId,
      taskId,
      projectRoot: project.rootPath,
      skipPushAfterCommit: git.skip_push_after_commit,
      shouldPush,
      promptLength: prompt.length,
    },
    "Starting commit runtime run",
  );

  try {
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      taskId,
      prompt,
      workflowKind: "commit",
      fallbackSlashCommand: "/aif-commit",
      systemPromptAppend: PROJECT_SCOPE_APPEND,
      usageContext: { source: UsageSource.COMMIT },
    });

    // Post-run drift check: the commit subagent runs git directly, so a
    // mid-run `git checkout` (rogue skill, bad fallback) would land the
    // commit on the wrong branch. Surface the drift instead of silently
    // returning ok.
    if (task?.branchName && !task.isFix) {
      try {
        assertCurrentBranch(project.rootPath, task.branchName);
      } catch (err) {
        const message = isBranchIsolationError(err)
          ? `Branch isolation failure (${err.kind}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
        log.error(
          { err, projectId, taskId, branchName: task.branchName },
          "Commit runtime aborted after run due to branch drift",
        );
        return { ok: false, error: message };
      }
    }

    log.info(
      {
        projectId,
        taskId,
        shouldPush,
        outputPreview: result.outputText?.slice(0, 200) ?? "",
      },
      "Commit runtime run completed successfully",
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, projectId, taskId }, "Commit runtime error");
    return { ok: false, error: message };
  }
}
