import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeSubagentQueryMock } = vi.hoisted(() => ({
  executeSubagentQueryMock: vi.fn(),
}));

vi.mock("../subagentQuery.js", () => ({
  executeSubagentQuery: executeSubagentQueryMock,
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

  it("passes haiku model when no Anthropic proxy base URL is configured", async () => {
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    await evaluateReviewCommentsForAutoMode(baseInput);

    expect(executeSubagentQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: "haiku",
        suppressModelFallback: false,
        workflowSpec: expect.objectContaining({
          sessionReusePolicy: "never",
        }),
      }),
    );
  });

  it("omits model override when Anthropic proxy base URL is configured", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example/v1";
    executeSubagentQueryMock.mockResolvedValueOnce({ resultText: "SUCCESS" });

    await evaluateReviewCommentsForAutoMode(baseInput);

    expect(executeSubagentQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: null,
        suppressModelFallback: true,
        workflowSpec: expect.objectContaining({
          sessionReusePolicy: "never",
        }),
      }),
    );
  });
});
