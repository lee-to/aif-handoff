import { describe, expect, it } from "vitest";
import { buildCommitPrompt } from "../commitWorkflow.js";

describe("buildCommitPrompt", () => {
  it("requires one conventional commit and a normal push when push is enabled", () => {
    const prompt = buildCommitPrompt(true);

    expect(prompt).toContain("Create exactly one commit");
    expect(prompt).toContain("run `git push`");
    expect(prompt).toContain("Do not force-push");
    expect(prompt).not.toContain("skip_push_after_commit");
  });

  it("requires a local-only commit when push is disabled", () => {
    const prompt = buildCommitPrompt(false);

    expect(prompt).toContain("Create exactly one commit");
    expect(prompt).toContain("Do NOT push");
    expect(prompt).toContain("git.skip_push_after_commit: true");
  });
});
