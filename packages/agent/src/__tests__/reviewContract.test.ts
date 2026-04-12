import { describe, expect, it } from "vitest";
import {
  buildStructuredReviewComments,
  createAutoReviewFindingId,
  normalizeFindingText,
  parseStructuredReviewComments,
  parseStructuredSidecarOutput,
} from "../reviewContract.js";

describe("reviewContract", () => {
  it("creates stable finding ids from normalized text", () => {
    const first = createAutoReviewFindingId("code_review", "Missing   null check");
    const second = createAutoReviewFindingId("code_review", "Missing null check");

    expect(first).toBe(second);
    expect(normalizeFindingText("  Missing   null check ")).toBe("Missing null check");
  });

  it("preserves previous finding source when parsing structured sidecar output", () => {
    const previousFindings = [
      {
        id: "persisted-1",
        source: "review_gate" as const,
        text: "Tighten regression coverage for retry path",
      },
    ];

    const parsed = parseStructuredSidecarOutput(
      [
        "## Blocking Findings",
        "- Add null guard before accessing runtime metadata",
        "",
        "## Advisories",
        "- none",
        "",
        "## Previous Findings",
        "- [persisted-1] still_blocking | Retry path still lacks regression coverage",
      ].join("\n"),
      "code_review",
      previousFindings,
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.previousFindings).toEqual([
      {
        id: "persisted-1",
        source: "review_gate",
        status: "still_blocking",
        note: "Retry path still lacks regression coverage",
        text: "Retry path still lacks regression coverage",
      },
    ]);
  });

  it("round-trips structured review comments with previous, blocking, and advisory sections", () => {
    const previousId = createAutoReviewFindingId(
      "code_review",
      "Ensure manual handoff badge is rendered on done tasks",
    );

    const reviewComments = buildStructuredReviewComments({
      strategy: "closure_first",
      iteration: 2,
      codeReview: {
        previousFindings: [
          {
            id: previousId,
            source: "code_review",
            status: "still_blocking",
            note: "Badge is still missing on the kanban card",
            text: "Badge is still missing on the kanban card",
          },
        ],
        blockingFindings: [
          {
            id: createAutoReviewFindingId("code_review", "Add manual review banner to detail view"),
            source: "code_review",
            text: "Add manual review banner to detail view",
          },
        ],
        advisories: [],
      },
      securityAudit: {
        previousFindings: [],
        blockingFindings: [],
        advisories: [
          {
            source: "security_audit",
            text: "Consider masking internal file paths in human-facing comments",
          },
        ],
      },
      rawCodeReview: "structured code review",
      rawSecurityAudit: "structured security audit",
    });

    const parsed = parseStructuredReviewComments(reviewComments);

    expect(parsed).not.toBeNull();
    expect(parsed?.strategy).toBe("closure_first");
    expect(parsed?.iteration).toBe(2);
    expect(parsed?.previousFindings).toEqual([
      {
        id: previousId,
        source: "code_review",
        status: "still_blocking",
        note: "Badge is still missing on the kanban card",
        text: "Badge is still missing on the kanban card",
      },
    ]);
    expect(parsed?.blockingFindings.map((finding) => finding.id)).toContain(previousId);
    expect(parsed?.advisories).toEqual([
      {
        source: "security_audit",
        text: "Consider masking internal file paths in human-facing comments",
      },
    ]);
  });
});
