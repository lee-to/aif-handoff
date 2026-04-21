import type { RuntimeEvent, RuntimeToolQuestionPayload } from "./types.js";

/**
 * Runtime-neutral builders for tool-related `RuntimeEvent`s.
 *
 * Every adapter that handles tool calls should emit events through these
 * helpers so consumers (chat UI, activity log, telemetry) see an identical
 * event shape regardless of which runtime produced them.
 *
 * Contract:
 * - A tool invocation always produces a `tool:use` event.
 * - If the tool is an interactive question (e.g. Claude's `AskUserQuestion`,
 *   Codex's future equivalent), the adapter parses its native input into a
 *   `RuntimeToolQuestionPayload` and passes it via `questionPayload` so a
 *   `tool:question` event is emitted alongside `tool:use`.
 */
export interface BuildToolUseEventsInput {
  /** Name of the tool as reported by the provider (e.g. "Bash", "AskUserQuestion"). */
  toolName: string;
  /** Provider-native call id when available — used by consumers for deduplication. */
  toolUseId: string | null;
  /** Raw tool input (unprocessed) — forwarded to listeners for logging/inspection. */
  input: unknown;
  /** ISO-8601 timestamp applied to every emitted event. */
  timestamp: string;
  /** Optional human-friendly suffix appended to the tool:use message. */
  detailSuffix?: string;
  /**
   * Normalized question payload when the tool is interactive. Adapters parse
   * their native shape and pass the result here; when `null` or `undefined`
   * the helper emits only `tool:use`.
   */
  questionPayload?: RuntimeToolQuestionPayload | null;
}

export function toolQuestionEvent(
  payload: RuntimeToolQuestionPayload,
  timestamp: string,
): RuntimeEvent {
  const joined = payload.questions
    .map((q) => (typeof q.question === "string" ? q.question.trim() : ""))
    .filter((text) => text.length > 0)
    .join(" | ");
  return {
    type: "tool:question",
    timestamp,
    level: "info",
    message: joined || payload.toolName,
    data: payload as unknown as Record<string, unknown>,
  };
}

export function buildToolUseEvents(params: BuildToolUseEventsInput): RuntimeEvent[] {
  const {
    toolName,
    toolUseId,
    input,
    timestamp,
    detailSuffix = "",
    questionPayload = null,
  } = params;
  const interactive = Boolean(questionPayload);
  const events: RuntimeEvent[] = [
    {
      type: "tool:use",
      timestamp,
      level: "info",
      message: `${toolName}${detailSuffix}`,
      data: { name: toolName, input, id: toolUseId, interactive },
    },
  ];
  if (questionPayload) {
    events.push(toolQuestionEvent(questionPayload, timestamp));
  }
  return events;
}
