import { buildRuntimeLimitSignature } from "@aif/shared";
import { RuntimeExecutionError } from "./errors.js";
import {
  RUNTIME_LIMIT_EVENT_TYPE,
  type RuntimeEvent,
  type RuntimeLimitEventPayload,
  type RuntimeLimitSnapshot,
} from "./types.js";

interface RuntimeLimitStateLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

interface RuntimeLimitEventOptions {
  logContext?: Record<string, unknown>;
  logger?: RuntimeLimitStateLogger;
  observedMessage?: string;
  malformedMessage?: string;
}

const DEFAULT_MALFORMED_MESSAGE = "Dropped runtime limit event with malformed snapshot payload";
const DEFAULT_OBSERVED_MESSAGE = "Observed runtime limit event";

function isRuntimeLimitSnapshot(value: unknown): value is RuntimeLimitSnapshot {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logMalformedRuntimeLimitEvent(
  event: RuntimeEvent,
  options?: RuntimeLimitEventOptions,
): void {
  options?.logger?.warn?.(
    {
      ...(options?.logContext ?? {}),
      eventType: event.type,
      runtimeEventTimestamp: event.timestamp,
    },
    options?.malformedMessage ?? DEFAULT_MALFORMED_MESSAGE,
  );
}

export function extractRuntimeLimitSnapshotFromEvent(
  event: RuntimeEvent,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  if (event.type !== RUNTIME_LIMIT_EVENT_TYPE) {
    return null;
  }

  const payload = event.data as RuntimeLimitEventPayload | undefined;
  if (!isRuntimeLimitSnapshot(payload?.snapshot)) {
    logMalformedRuntimeLimitEvent(event, options);
    return null;
  }

  return payload.snapshot;
}

export function observeRuntimeLimitEvent(
  event: RuntimeEvent,
  currentSnapshot: RuntimeLimitSnapshot | null,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  const snapshot = extractRuntimeLimitSnapshotFromEvent(event, options);
  if (!snapshot) {
    return currentSnapshot;
  }

  options?.logger?.debug?.(
    {
      ...(options?.logContext ?? {}),
      runtimeId: snapshot.runtimeId ?? null,
      providerId: snapshot.providerId,
      profileId: snapshot.profileId ?? null,
      status: snapshot.status,
      precision: snapshot.precision,
      source: snapshot.source,
      resetAt: snapshot.resetAt ?? null,
    },
    options?.observedMessage ?? DEFAULT_OBSERVED_MESSAGE,
  );

  return snapshot;
}

export function extractLatestRuntimeLimitSnapshot(
  events: RuntimeEvent[] | null | undefined,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  if (!events?.length) {
    return null;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const snapshot = extractRuntimeLimitSnapshotFromEvent(events[index]!, options);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

export function extractRuntimeLimitSnapshotFromError(error: unknown): RuntimeLimitSnapshot | null {
  if (error instanceof RuntimeExecutionError && error.limitSnapshot) {
    return error.limitSnapshot;
  }
  if (error instanceof Error && "cause" in error && error.cause) {
    return extractRuntimeLimitSnapshotFromError(error.cause);
  }
  return null;
}

export function buildRuntimeLimitCacheSignature(
  snapshot: RuntimeLimitSnapshot | null,
  clearOnMissing: boolean,
): string | null {
  if (snapshot) {
    return `persist:${buildRuntimeLimitSignature(snapshot)}`;
  }
  if (clearOnMissing) {
    return "clear";
  }
  return null;
}

export function buildRuntimeLimitBroadcastCacheKey(input: {
  projectId?: string | null;
  taskId?: string | null;
  runtimeProfileId: string;
}): string | null {
  const projectId = input.projectId ?? null;
  if (!projectId) {
    return null;
  }
  return `${projectId}:${input.runtimeProfileId}:${input.taskId ?? ""}`;
}
