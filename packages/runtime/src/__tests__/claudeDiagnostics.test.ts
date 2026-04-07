import { describe, it, expect } from "vitest";
import { diagnoseClaudeError } from "../adapters/claude/diagnostics.js";

describe("diagnoseClaudeError", () => {
  it("classifies login failures", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("Claude Code process exited with code 1"),
      stderrTail: "Not logged in · Please run /login",
    });
    expect(reason).toContain("not logged in");
  });

  it("classifies usage limit failures", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("Claude Code process exited with code 1"),
      stderrTail: "Rate limit reached for this account",
    });
    expect(reason).toContain("usage limit reached");
  });

  it("classifies stream interruption failures", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("Implementer failed"),
      stderrTail: "Error in hook callback: Stream closed",
    });
    expect(reason).toContain("stream interrupted");
  });

  it("returns base message when no stderr and no projectRoot", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("Something went wrong"),
    });
    expect(reason).toBe("Something went wrong");
  });

  it("appends stderr to base message", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("Adapter failed"),
      stderrTail: "Unexpected token",
    });
    expect(reason).toContain("Adapter failed");
    expect(reason).toContain("Unexpected token");
  });

  it("classifies out of extra usage", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("out of extra usage"),
    });
    expect(reason).toContain("usage limit reached");
  });

  it("classifies quota exceeded", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("quota exceeded"),
      stderrTail: "",
    });
    expect(reason).toContain("usage limit reached");
  });

  it("classifies credits exhausted", async () => {
    const reason = await diagnoseClaudeError({
      error: "credits depleted",
    });
    expect(reason).toContain("usage limit reached");
  });

  it("handles non-Error thrown values", async () => {
    const reason = await diagnoseClaudeError({
      error: "plain string error",
    });
    expect(reason).toBe("plain string error");
  });

  it("explains exit code 1 without stderr", async () => {
    const reason = await diagnoseClaudeError({
      error: new Error("process exited with code 1"),
    });
    expect(reason).toContain("auth or usage-limit");
  });
});
