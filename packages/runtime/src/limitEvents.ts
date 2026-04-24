import {
  RuntimeLimitStatus,
  RUNTIME_LIMIT_EVENT_TYPE,
  type RuntimeEvent,
  type RuntimeLimitEventPayload,
  type RuntimeLimitSnapshot,
} from "./types.js";

function resolveLevel(status: RuntimeLimitSnapshot["status"]): RuntimeEvent["level"] {
  switch (status) {
    case RuntimeLimitStatus.BLOCKED:
      return "warn";
    case RuntimeLimitStatus.WARNING:
      return "info";
    case RuntimeLimitStatus.OK:
      return "debug";
    default:
      return "debug";
  }
}

function resolveMessage(status: RuntimeLimitSnapshot["status"]): string {
  switch (status) {
    case RuntimeLimitStatus.BLOCKED:
      return "Runtime limit state changed: blocked";
    case RuntimeLimitStatus.WARNING:
      return "Runtime limit state changed: warning";
    case RuntimeLimitStatus.OK:
      return "Runtime limit state changed: ok";
    default:
      return "Runtime limit state updated";
  }
}

export function buildRuntimeLimitEvent(
  snapshot: RuntimeLimitSnapshot,
  rawType?: string | null,
): RuntimeEvent {
  const data: RuntimeLimitEventPayload = {
    snapshot,
    ...(rawType ? { rawType } : {}),
  };

  return {
    type: RUNTIME_LIMIT_EVENT_TYPE,
    timestamp: snapshot.checkedAt,
    level: resolveLevel(snapshot.status),
    message: resolveMessage(snapshot.status),
    data: data as unknown as Record<string, unknown>,
  };
}
