import { createRuntimeWorkflowSpec } from "@aif/runtime";
import type { AutoReviewFinding, AutoReviewStrategy } from "@aif/shared";
import {
  createAutoReviewFindingId,
  parseStructuredReviewComments,
  toAutoReviewState,
  type ParsedStructuredReviewComments,
} from "./reviewContract.js";
import { executeSubagentQuery } from "./subagentQuery.js";

export type ReviewGateParserMode = "structured" | "fallback";

export type ReviewGateManualHandoffReason =
  | "new_blockers_after_rework"
  | "malformed_review_output_fallback";

export interface ReviewGateMetrics {
  strategy: AutoReviewStrategy;
  iteration: number;
  previousBlockingCount: number;
  stillBlockingCount: number;
  newBlockingCount: number;
  totalBlockingCount: number;
  parserMode: ReviewGateParserMode;
}

type ReviewGateBaseResult = {
  metrics: ReviewGateMetrics;
  blockingFindings: AutoReviewFinding[];
  fixesMarkdown: string;
};

export type ReviewGateResult =
  | (ReviewGateBaseResult & {
      status: "success";
      autoReviewState: null;
    })
  | (ReviewGateBaseResult & {
      status: "request_changes";
      autoReviewState: ReturnType<typeof toAutoReviewState>;
    })
  | (ReviewGateBaseResult & {
      status: "manual_review_required";
      autoReviewState: ReturnType<typeof toAutoReviewState>;
      handoffReason: ReviewGateManualHandoffReason;
    });

export interface ReviewGateInput {
  taskId: string;
  projectRoot: string;
  reviewComments: string | null;
  strategy: AutoReviewStrategy;
  iteration: number;
  previousFindings: AutoReviewFinding[];
}

const SUCCESS_TOKEN = "SUCCESS";

function formatFixesMarkdown(findings: AutoReviewFinding[]): string {
  if (findings.length === 0) {
    return "- none";
  }

  return findings
    .map((finding) => `- [${finding.id}] ${finding.source} | ${finding.text}`)
    .join("\n");
}

function mergeFindings(...groups: AutoReviewFinding[][]): AutoReviewFinding[] {
  const map = new Map<string, AutoReviewFinding>();
  for (const group of groups) {
    for (const finding of group) {
      map.set(finding.id, finding);
    }
  }
  return [...map.values()];
}

async function runLegacyFallbackExtraction(
  input: Pick<ReviewGateInput, "taskId" | "projectRoot" | "reviewComments">,
): Promise<AutoReviewFinding[]> {
  const normalizedComments = (input.reviewComments ?? "").trim();
  const prompt = `Read the review comments and extract only the points that must be fixed.

Review comments:
${normalizedComments.length > 0 ? normalizedComments : "No review comments provided."}

Rules:
1) If there are no issues that require fixes, return exactly one word: SUCCESS
2) If there are issues, return ONLY markdown bullet points in this exact format: "- <required fix>"
3) Output must be either:
   - exactly "SUCCESS"
   - or one or more lines, each starting with "- "
4) Do not include numbering, headings, prose, code fences, or any extra text`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "review-gate",
    prompt,
    requiredCapabilities: [],
    fallbackStrategy: "none",
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  const { resultText } = await executeSubagentQuery({
    taskId: input.taskId,
    projectRoot: input.projectRoot,
    agentName: "review-gate",
    prompt,
    workflowSpec,
    workflowKind: "review-gate",
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  const normalizedResultText = resultText.trim();
  if (!normalizedResultText) {
    throw new Error("Review auto-check returned empty response");
  }

  if (normalizedResultText.toUpperCase() === SUCCESS_TOKEN) {
    return [];
  }

  const trimmedLines = normalizedResultText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bulletLines = trimmedLines.filter((line) => line.startsWith("- "));
  const hasOnlyBulletLines = bulletLines.length > 0 && bulletLines.length === trimmedLines.length;
  if (!hasOnlyBulletLines) {
    return [];
  }

  return bulletLines.map((line) => {
    const text = line.slice(2).trim();
    return {
      id: createAutoReviewFindingId("review_gate", text),
      source: "review_gate" as const,
      text,
    };
  });
}

function buildMetrics(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  previousBlockingCount: number;
  stillBlockingCount: number;
  newBlockingCount: number;
  totalBlockingCount: number;
  parserMode: ReviewGateParserMode;
}): ReviewGateMetrics {
  return {
    strategy: input.strategy,
    iteration: input.iteration,
    previousBlockingCount: input.previousBlockingCount,
    stillBlockingCount: input.stillBlockingCount,
    newBlockingCount: input.newBlockingCount,
    totalBlockingCount: input.totalBlockingCount,
    parserMode: input.parserMode,
  };
}

function buildStructuredDecision(
  input: ReviewGateInput,
  parsed: ParsedStructuredReviewComments,
): ReviewGateResult {
  const previousIds = new Set(input.previousFindings.map((finding) => finding.id));
  const stillBlockingIds = new Set(
    parsed.previousFindings
      .filter((finding) => finding.status === "still_blocking")
      .map((finding) => finding.id),
  );
  const newBlockingFindings = parsed.blockingFindings.filter(
    (finding) => !previousIds.has(finding.id),
  );
  const metrics = buildMetrics({
    strategy: input.strategy,
    iteration: input.iteration,
    previousBlockingCount: input.previousFindings.length,
    stillBlockingCount: stillBlockingIds.size,
    newBlockingCount: newBlockingFindings.length,
    totalBlockingCount: parsed.blockingFindings.length,
    parserMode: "structured",
  });

  if (parsed.blockingFindings.length === 0) {
    return {
      status: "success",
      metrics,
      blockingFindings: [],
      fixesMarkdown: "- none",
      autoReviewState: null,
    };
  }

  const autoReviewState = toAutoReviewState({
    strategy: input.strategy,
    iteration: input.iteration,
    findings: parsed.blockingFindings,
  });

  if (
    input.strategy === "closure_first" &&
    input.previousFindings.length > 0 &&
    stillBlockingIds.size === 0 &&
    newBlockingFindings.length > 0
  ) {
    return {
      status: "manual_review_required",
      handoffReason: "new_blockers_after_rework",
      metrics,
      blockingFindings: parsed.blockingFindings,
      fixesMarkdown: formatFixesMarkdown(parsed.blockingFindings),
      autoReviewState,
    };
  }

  return {
    status: "request_changes",
    metrics,
    blockingFindings: parsed.blockingFindings,
    fixesMarkdown: formatFixesMarkdown(parsed.blockingFindings),
    autoReviewState,
  };
}

function buildFallbackDecision(
  input: ReviewGateInput,
  fallbackFindings: AutoReviewFinding[],
): ReviewGateResult {
  const mergedFindings =
    input.previousFindings.length > 0
      ? mergeFindings(input.previousFindings, fallbackFindings)
      : fallbackFindings;
  const metrics = buildMetrics({
    strategy: input.strategy,
    iteration: input.iteration,
    previousBlockingCount: input.previousFindings.length,
    stillBlockingCount: input.previousFindings.length > 0 ? input.previousFindings.length : 0,
    newBlockingCount: fallbackFindings.length,
    totalBlockingCount: mergedFindings.length,
    parserMode: "fallback",
  });

  if (input.previousFindings.length > 0) {
    return {
      status: "manual_review_required",
      handoffReason: "malformed_review_output_fallback",
      metrics,
      blockingFindings: mergedFindings,
      fixesMarkdown: formatFixesMarkdown(mergedFindings),
      autoReviewState: toAutoReviewState({
        strategy: input.strategy,
        iteration: input.iteration,
        findings: mergedFindings,
      }),
    };
  }

  if (fallbackFindings.length === 0) {
    return {
      status: "success",
      metrics,
      blockingFindings: [],
      fixesMarkdown: "- none",
      autoReviewState: null,
    };
  }

  return {
    status: "request_changes",
    metrics,
    blockingFindings: fallbackFindings,
    fixesMarkdown: formatFixesMarkdown(fallbackFindings),
    autoReviewState: toAutoReviewState({
      strategy: input.strategy,
      iteration: input.iteration,
      findings: fallbackFindings,
    }),
  };
}

export async function evaluateReviewCommentsForAutoMode(
  input: ReviewGateInput,
): Promise<ReviewGateResult> {
  const parsedStructuredComments = parseStructuredReviewComments(input.reviewComments);
  if (parsedStructuredComments) {
    return buildStructuredDecision(input, parsedStructuredComments);
  }

  const fallbackFindings = await runLegacyFallbackExtraction(input);
  return buildFallbackDecision(input, fallbackFindings);
}
