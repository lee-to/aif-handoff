import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { tasks, getEnv } from "@aif/shared";
import { getDb } from "@aif/shared/server";

export interface TaskAttempt {
  taskId: string;
  attemptId: string;
  coordinatorId: string;
  ownershipRevision: number;
}

const attempts = new AsyncLocalStorage<TaskAttempt>();
const ATTEMPT_RECOVERY_ENABLED = getEnv().AIF_AGENT_ATTEMPT_RECOVERY_ENABLED;

/** Resolve rollout once at initialization, consistently for all repository consumers. */
export function isTaskAttemptRecoveryEnabled(): boolean {
  return ATTEMPT_RECOVERY_ENABLED;
}

export class SupersededTaskAttemptError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} execution attempt no longer owns the stage`);
    this.name = "SupersededTaskAttemptError";
  }
}

export function withTaskAttempt<T>(attempt: TaskAttempt, run: () => T): T {
  return attempts.run({ ...attempt }, run);
}

export function getTaskAttempt(): TaskAttempt | undefined {
  return attempts.getStore();
}

/** Calls outside a coordinator attempt (API, watchdog, standalone queries) keep their contract. */
export function isTaskAttemptCurrent(taskId: string): boolean {
  const attempt = attempts.getStore();
  if (!attempt) return true;
  if (attempt.taskId !== taskId) return false;
  return Boolean(
    getDb()
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.stageAttemptId, attempt.attemptId),
          eq(tasks.lockedBy, attempt.coordinatorId),
          eq(tasks.ownershipRevision, attempt.ownershipRevision),
        ),
      )
      .get(),
  );
}

export function assertTaskAttemptCurrent(taskId: string): void {
  if (!isTaskAttemptCurrent(taskId)) throw new SupersededTaskAttemptError(taskId);
}

/** Validate and write in one synchronous SQLite transaction, including across processes. */
export function guardTaskAttemptWrite<T>(taskId: string, write: () => T): T {
  if (!attempts.getStore()) return write();
  return getDb().transaction(
    () => {
      assertTaskAttemptCurrent(taskId);
      return write();
    },
    { behavior: "immediate" },
  );
}

/** A successful handoff by this attempt may finish persisting its manual-review outcome. */
export function acceptTaskAttemptHandoff(taskId: string, ownershipRevision: number): void {
  const attempt = attempts.getStore();
  if (attempt?.taskId === taskId) attempt.ownershipRevision = ownershipRevision;
}
