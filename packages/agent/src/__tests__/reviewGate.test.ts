import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeSubagentQueryMock, resolveAdapterForTaskMock } = vi.hoisted(() => ({
  executeSubagentQueryMock: vi.fn(),
  resolveAdapterForTaskMock: vi.fn().mockResolvedValue({
    descriptor: { lightModel: "claude-haiku-3-5" },
  }),
}));

vi.mock("../subagentQuery.js", () => ({
  executeSubagentQuery: executeSubagentQueryMock,
  resolveAdapterForTask: resolveAdapterForTaskMock,
}));

import { evaluateReviewCommentsForAutoMode } from "../reviewGate.js";

describe("evaluateReviewCommentsForAutoMode", () => {
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const baseInput = {
    taskId: "test-task-1",
    projectRoot: "/tmp/test-project",
    reviewComments: "## Code Review\n\nLooks good, no issues found.",
  };

  beforeEach(() => {
    executeSubagentQueryMock.mockReset();
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterAll(() => {
    if (originalAnthropicBaseUrl == null) {
      delete process.env.ANTHROPIC_BASE_URL;
      return;
    }
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  });

  it("returns success when agent responds with SUCCESS", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    const result = await evaluateReviewCommentsForAutoMode(baseInput);
    expect(result).toEqual({ status: "success" });
  });

  it("returns request_changes when agent responds with fixes", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({
      resultText: "- Fix missing error handling in api.ts\n- Add input validation",
    });

    const result = await evaluateReviewCommentsForAutoMode(baseInput);
    expect(result.status).toBe("request_changes");
    if (result.status === "request_changes") {
      expect(result.fixes).toContain("Fix missing error handling");
      expect(result.fixes).toContain("Add input validation");
    }
  });

  it("handles null reviewComments", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    const result = await evaluateReviewCommentsForAutoMode({
      ...baseInput,
      reviewComments: null,
    });
    expect(result).toEqual({ status: "success" });
  });

  it("throws on empty response", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "   " });

    await expect(evaluateReviewCommentsForAutoMode(baseInput)).rejects.toThrow(
      "Review auto-check returned empty response",
    );
  });

  it("treats free-form prose (no bullets) as success to avoid false rework", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({
      resultText: "The code looks good overall but could use some minor improvements in naming.",
    });

    const result = await evaluateReviewCommentsForAutoMode(baseInput);
    expect(result).toEqual({ status: "success" });
  });

  it("treats mixed prose+bullets as success because format is invalid", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({
      resultText:
        "Here are the issues:\n- Fix missing null check\nSome extra commentary\n- Add error handling",
    });

    const result = await evaluateReviewCommentsForAutoMode(baseInput);
    expect(result).toEqual({ status: "success" });
  });

  it("is case-insensitive for SUCCESS token", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "success" });

    const result = await evaluateReviewCommentsForAutoMode(baseInput);
    expect(result).toEqual({ status: "success" });
  });

  it("uses adapter lightModel for review-gate model override", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    await evaluateReviewCommentsForAutoMode(baseInput);

    const call = executeSubagentQueryMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.modelOverride).toBe("claude-haiku-3-5");
    expect(call.suppressModelFallback).toBeUndefined();
    expect(call.workflowSpec).toEqual(expect.objectContaining({ sessionReusePolicy: "never" }));
  });

  it("uses profile model fallback when adapter has no lightModel", async () => {
    resolveAdapterForTaskMock.mockResolvedValueOnce({
      descriptor: { lightModel: null },
    });
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    await evaluateReviewCommentsForAutoMode(baseInput);

    const call = executeSubagentQueryMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.modelOverride).toBeNull();
    expect(call.suppressModelFallback).toBeUndefined();
    expect(call.workflowSpec).toEqual(expect.objectContaining({ sessionReusePolicy: "never" }));
  });
});
