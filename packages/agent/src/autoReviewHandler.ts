/**
 * Auto review gate handler — evaluates review comments in autoMode
 * and decides whether to accept, request rework, or stop at manual review.
 */

import { createTaskComment, findTaskById } from "@aif/data";
import { getEnv, logger, type AutoReviewState } from "@aif/shared";
import { logActivity } from "./hooks.js";
import {
  evaluateReviewCommentsForAutoMode,
  type ReviewGateManualHandoffReason,
  type ReviewGateMetrics,
} from "./reviewGate.js";

const log = logger("auto-review-handler");

export type AutoReviewHandlerHandoffReason = ReviewGateManualHandoffReason | "max_iterations";

export type ReviewGateOutcome =
  | {
      status: "accepted";
      currentIteration: number;
      metrics: ReviewGateMetrics;
      autoReviewState: null;
    }
  | {
      status: "rework_requested";
      currentIteration: number;
      metrics: ReviewGateMetrics;
      autoReviewState: AutoReviewState;
    }
  | {
      status: "manual_review_required";
      currentIteration: number;
      metrics: ReviewGateMetrics;
      autoReviewState: AutoReviewState;
      handoffReason: AutoReviewHandlerHandoffReason;
    };

interface AutoReviewInput {
  taskId: string;
  projectRoot: string;
}

function buildSummaryComment(input: {
  outcome: "success" | "request_changes" | "manual_review_required";
  metrics: ReviewGateMetrics;
  currentIteration: number;
  maxIterations: number;
  fixesMarkdown: string;
  handoffReason?: AutoReviewHandlerHandoffReason;
}): string {
  const lines = [
    "## Auto Review Gate Summary",
    `- Outcome: ${input.outcome}`,
    `- Strategy: ${input.metrics.strategy}`,
    `- Parser mode: ${input.metrics.parserMode}`,
    `- Review iteration: ${input.currentIteration}/${input.maxIterations}`,
    `- Previous blocking findings: ${input.metrics.previousBlockingCount}`,
    `- Still-blocking previous findings: ${input.metrics.stillBlockingCount}`,
    `- New blocking findings: ${input.metrics.newBlockingCount}`,
    `- Total blocking findings: ${input.metrics.totalBlockingCount}`,
  ];

  if (input.handoffReason) {
    lines.push(`- Handoff reason: ${input.handoffReason}`);
  }

  lines.push("");

  if (input.outcome === "success") {
    lines.push("Review comments passed auto-gate; transitioning task to Done.");
    return lines.join("\n");
  }

  if (input.outcome === "manual_review_required") {
    lines.push(
      "Automatic review convergence stopped. Human review is required before final resolution.",
    );
  } else {
    lines.push("Automatic review found blocking issues. Returning task to implementing.");
  }

  lines.push("");
  lines.push("## Blocking Findings");
  lines.push(input.fixesMarkdown);

  return lines.join("\n");
}

function buildActivityMessage(input: {
  outcome: "accepted" | "rework_requested" | "manual_review_required";
  metrics: ReviewGateMetrics;
  currentIteration: number;
  maxIterations: number;
  handoffReason?: AutoReviewHandlerHandoffReason;
}): string {
  const base =
    `coordinator auto review gate ${input.outcome}: ` +
    `strategy=${input.metrics.strategy}, ` +
    `iteration=${input.currentIteration}/${input.maxIterations}, ` +
    `previous=${input.metrics.previousBlockingCount}, ` +
    `still=${input.metrics.stillBlockingCount}, ` +
    `new=${input.metrics.newBlockingCount}, ` +
    `total=${input.metrics.totalBlockingCount}, ` +
    `parser=${input.metrics.parserMode}`;

  if (!input.handoffReason) {
    return base;
  }

  return `${base}, reason=${input.handoffReason}`;
}

export async function handleAutoReviewGate(
  input: AutoReviewInput,
): Promise<ReviewGateOutcome | null> {
  const env = getEnv();
  const refreshedTask = findTaskById(input.taskId);
  if (!refreshedTask?.autoMode) {
    return null;
  }

  const currentIteration = (refreshedTask.reviewIterationCount ?? 0) + 1;
  const maxIterations = refreshedTask.maxReviewIterations ?? env.AGENT_MAX_REVIEW_ITERATIONS;

  logActivity(
    input.taskId,
    "Agent",
    "coordinator auto review gate started: validating structured review output before done transition",
  );

  const reviewGate = await evaluateReviewCommentsForAutoMode({
    taskId: input.taskId,
    projectRoot: input.projectRoot,
    reviewComments: refreshedTask.reviewComments,
    strategy: env.AGENT_AUTO_REVIEW_STRATEGY,
    iteration: currentIteration,
    previousFindings: refreshedTask.autoReviewState?.findings ?? [],
  });

  if (reviewGate.status === "success") {
    createTaskComment({
      taskId: input.taskId,
      author: "agent",
      message: buildSummaryComment({
        outcome: "success",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
        fixesMarkdown: reviewGate.fixesMarkdown,
      }),
      attachments: [],
    });

    logActivity(
      input.taskId,
      "Agent",
      buildActivityMessage({
        outcome: "accepted",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
      }),
    );

    return {
      status: "accepted",
      currentIteration,
      metrics: reviewGate.metrics,
      autoReviewState: null,
    };
  }

  if (reviewGate.status === "request_changes" && currentIteration >= maxIterations) {
    createTaskComment({
      taskId: input.taskId,
      author: "agent",
      message: buildSummaryComment({
        outcome: "manual_review_required",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
        fixesMarkdown: reviewGate.fixesMarkdown,
        handoffReason: "max_iterations",
      }),
      attachments: [],
    });

    log.warn(
      {
        taskId: input.taskId,
        currentIteration,
        maxIterations,
        metrics: reviewGate.metrics,
      },
      "Auto review reached max iterations; manual review required",
    );

    logActivity(
      input.taskId,
      "Agent",
      buildActivityMessage({
        outcome: "manual_review_required",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
        handoffReason: "max_iterations",
      }),
    );

    return {
      status: "manual_review_required",
      currentIteration,
      metrics: reviewGate.metrics,
      autoReviewState: reviewGate.autoReviewState,
      handoffReason: "max_iterations",
    };
  }

  if (reviewGate.status === "request_changes") {
    createTaskComment({
      taskId: input.taskId,
      author: "agent",
      message: buildSummaryComment({
        outcome: "request_changes",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
        fixesMarkdown: reviewGate.fixesMarkdown,
      }),
      attachments: [],
    });

    log.info(
      {
        taskId: input.taskId,
        currentIteration,
        maxIterations,
        metrics: reviewGate.metrics,
      },
      "Auto review requested another rework cycle",
    );

    logActivity(
      input.taskId,
      "Agent",
      buildActivityMessage({
        outcome: "rework_requested",
        metrics: reviewGate.metrics,
        currentIteration,
        maxIterations,
      }),
    );

    return {
      status: "rework_requested",
      currentIteration,
      metrics: reviewGate.metrics,
      autoReviewState: reviewGate.autoReviewState,
    };
  }

  createTaskComment({
    taskId: input.taskId,
    author: "agent",
    message: buildSummaryComment({
      outcome: "manual_review_required",
      metrics: reviewGate.metrics,
      currentIteration,
      maxIterations,
      fixesMarkdown: reviewGate.fixesMarkdown,
      handoffReason: reviewGate.handoffReason,
    }),
    attachments: [],
  });

  log.warn(
    {
      taskId: input.taskId,
      currentIteration,
      maxIterations,
      handoffReason: reviewGate.handoffReason,
      metrics: reviewGate.metrics,
    },
    "Auto review stopped at manual handoff",
  );

  logActivity(
    input.taskId,
    "Agent",
    buildActivityMessage({
      outcome: "manual_review_required",
      metrics: reviewGate.metrics,
      currentIteration,
      maxIterations,
      handoffReason: reviewGate.handoffReason,
    }),
  );

  return {
    status: "manual_review_required",
    currentIteration,
    metrics: reviewGate.metrics,
    autoReviewState: reviewGate.autoReviewState,
    handoffReason: reviewGate.handoffReason,
  };
}
