import type {
  RuntimeTransport,
  RuntimeUsage,
  RuntimeUsageContext,
  UsageReporting,
} from "./types.js";

/**
 * Event recorded by the registry wrapper after every successful adapter run
 * that returned a non-null `usage`. The sink is the single point of persistence
 * for token/cost accounting across the whole system.
 */
export interface RuntimeUsageEvent {
  /** Scope metadata passed in via `RuntimeRunInput.usageContext`. */
  context: RuntimeUsageContext;
  /** Which runtime produced this usage. */
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  transport?: RuntimeTransport;
  /** Workflow kind declared on the run (planner, chat, commit, ...). */
  workflowKind?: string;
  /** Adapter's declared usage-reporting contract at the time of recording. */
  usageReporting: UsageReporting;
  /** Concrete token counts and cost from the run. */
  usage: RuntimeUsage;
  /** When the wrapper observed the event. */
  recordedAt: Date;
}

/**
 * Usage sink contract. Implementations persist the event (typically into a
 * `usage_events` table and rolled-up aggregates on projects/tasks/chat-sessions).
 *
 * `record` must be synchronous and non-throwing — the wrapper calls it in the
 * hot path of every run, and a failure here must never break the caller.
 * Implementations should catch and log their own errors internally.
 */
export interface RuntimeUsageSink {
  record(event: RuntimeUsageEvent): void;
}

/**
 * No-op sink used when no explicit sink is configured (tests, isolated tools).
 * Discards every event silently.
 */
export function createNoopUsageSink(): RuntimeUsageSink {
  return {
    record() {
      /* intentionally empty */
    },
  };
}
