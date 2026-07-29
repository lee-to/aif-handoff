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
