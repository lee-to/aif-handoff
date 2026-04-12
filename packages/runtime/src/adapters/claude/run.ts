import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
import { isRetriableTimeoutError, resolveRetryDelay } from "../../timeouts.js";
import { classifyClaudeRuntimeError } from "./errors.js";
import { parseExecutionOptions } from "./options.js";
import { runClaudeQueryAttempt } from "./stream.js";

export type { ClaudeRuntimeExecutionOptions } from "./options.js";

export interface ClaudeRuntimeRunLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * String matching is intentional here: Claude Agent SDK surfaces session-not-found
 * as a plain Error(message) with no structured error class, HTTP status, or subtype.
 * These are SDK-internal session lifecycle signals that only appear as message strings.
 */
function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("no conversation found with session id") ||
    lowered.includes("no conversation found for session id") ||
    lowered.includes("session not found")
  );
}

/**
 * String matching is intentional here: Claude Agent SDK exposes execution failures
 * and error results as plain Error(message) strings. No structured error class or
 * HTTP status is available for these SDK-internal signals.
 */
function isRetryableResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    isMissingResumeSessionError(error) ||
    lowered.includes("error_during_execution") ||
    lowered.includes("claude code returned an error result")
  );
}

function toResult(attempt: {
  outputText: string;
  sessionId: string | null;
  events: import("../../types.js").RuntimeEvent[];
  usage: import("../../types.js").RuntimeUsage | null;
}): RuntimeRunResult {
  return {
    outputText: attempt.outputText,
    sessionId: attempt.sessionId,
    events: attempt.events,
    usage: attempt.usage,
  };
}

/**
 * Run a prompt through the Claude Agent SDK with:
 * - query_start_timeout detection + single retry
 * - resume failure detection + fallback to fresh session
 * - structured error classification
 */
export async function runClaudeRuntime(
  input: RuntimeRunInput,
  logger: ClaudeRuntimeRunLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeRunResult> {
  const execution = parseExecutionOptions(input, adapterDefaults);
  const retryDelayMs = resolveRetryDelay({
    startRetryDelayMs: execution.queryStartRetryDelayMs,
  });

  logger.info(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      workflowKind: input.workflowKind ?? null,
      profileId: input.profileId ?? null,
      model: input.model ?? null,
      resume: Boolean(input.resume && input.sessionId),
      hasAgentDefinitionName: Boolean(execution.agentDefinitionName),
      maxBudgetUsd: execution.maxBudgetUsd ?? null,
      startTimeoutMs: execution.queryStartTimeoutMs ?? null,
      runTimeoutMs: execution.runTimeoutMs ?? null,
    },
    "Starting Claude runtime run",
  );

  try {
    const attempt = await runClaudeQueryAttempt(input, execution, logger);
    logger.info(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        hasSessionId: Boolean(attempt.sessionId),
      },
      "Claude runtime run completed",
    );
    return toResult(attempt);
  } catch (error) {
    // Retry path 1: resume failed (missing session / execution error) → fresh session
    if (input.resume && input.sessionId && isRetryableResumeFailure(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          resumeSessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Claude runtime resume attempt failed, retrying without resume",
      );
      await sleep(retryDelayMs);
      try {
        return toResult(
          await runClaudeQueryAttempt(
            { ...input, resume: false, sessionId: null },
            execution,
            logger,
          ),
        );
      } catch (resumeRetryError) {
        const classified = classifyClaudeRuntimeError(resumeRetryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            code: classified.adapterCode,
            error: classified.message,
          },
          "Claude runtime run failed after missing-session resume retry",
        );
        throw classified;
      }
    }

    // Retry path 2: start timeout (retriable) → single retry
    if (isRetriableTimeoutError(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          startTimeoutMs: execution.queryStartTimeoutMs ?? null,
        },
        "Claude runtime start timeout detected, retrying once",
      );
      await sleep(retryDelayMs);
      try {
        return toResult(await runClaudeQueryAttempt(input, execution, logger));
      } catch (retryError) {
        const classified = classifyClaudeRuntimeError(retryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            code: classified.adapterCode,
            error: classified.message,
          },
          "Claude runtime run failed after retry",
        );
        throw classified;
      }
    }

    // Terminal failure
    const classified = classifyClaudeRuntimeError(error);
    logger.error(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        code: classified.adapterCode,
        error: classified.message,
      },
      "Claude runtime run failed",
    );
    throw classified;
  }
}
