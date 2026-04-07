import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
import { classifyClaudeRuntimeError } from "./errors.js";
import { parseExecutionOptions } from "./options.js";
import { isQueryStartTimeoutError, runClaudeQueryAttempt } from "./stream.js";

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

function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("no conversation found with session id") ||
    lowered.includes("no conversation found for session id") ||
    lowered.includes("session not found")
  );
}

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
  const timeoutMs = Math.max(execution.queryStartTimeoutMs ?? 60_000, 1);
  const retryDelayMs = Math.max(execution.queryStartRetryDelayMs ?? 1_000, 0);

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
    },
    "Starting Claude runtime run",
  );

  try {
    const attempt = await runClaudeQueryAttempt(input, execution, timeoutMs);
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
            timeoutMs,
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

    // Retry path 2: query_start_timeout → single retry
    if (isQueryStartTimeoutError(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          timeoutMs,
        },
        "Claude runtime query_start_timeout detected, retrying once",
      );
      await sleep(retryDelayMs);
      try {
        return toResult(await runClaudeQueryAttempt(input, execution, timeoutMs));
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
