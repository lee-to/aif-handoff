/**
 * Per-task AbortController registry for concurrent coordinator stages.
 * Supports parallel task execution — each task gets its own controller.
 */

import { releaseTaskClaim, getTaskAttempt } from "@aif/data";

const _activeAborts = new Map<string, { abort: AbortController; attemptId?: string }>();

export function setActiveStageAbortController(taskId: string, abort: AbortController | null): void {
  if (abort) {
    const previous = _activeAborts.get(taskId);
    if (getTaskAttempt() && previous && previous.abort !== abort) previous.abort.abort();
    _activeAborts.set(taskId, { abort, attemptId: getTaskAttempt()?.attemptId });
  } else {
    if (_activeAborts.get(taskId)?.attemptId === getTaskAttempt()?.attemptId)
      _activeAborts.delete(taskId);
  }
}

export function getActiveStageAbortController(taskId?: string): AbortController | null {
  if (taskId) {
    const entry = _activeAborts.get(taskId);
    const attemptId = getTaskAttempt()?.attemptId;
    if (attemptId && entry?.attemptId !== attemptId) return null;
    return entry?.abort ?? null;
  }
  // Backward compat: if only one active, return it
  if (_activeAborts.size === 1) {
    return _activeAborts.values().next().value?.abort ?? null;
  }
  return null;
}

/** Abort all active stages and release their locks (used during shutdown). */
export function abortAllActiveStages(): void {
  for (const [taskId, { abort, attemptId }] of _activeAborts) {
    if (!abort.signal.aborted) abort.abort();
    try {
      releaseTaskClaim(taskId, undefined, attemptId);
    } catch {
      /* best-effort during shutdown */
    }
    _activeAborts.delete(taskId);
  }
}
