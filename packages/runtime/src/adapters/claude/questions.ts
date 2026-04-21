import type { RuntimeToolQuestionPayload } from "../../types.js";

/**
 * Parse Claude's `AskUserQuestion` tool input into the runtime-neutral
 * `RuntimeToolQuestionPayload` shape. Returns `null` when the input does not
 * contain at least one question — callers should fall back to the plain
 * `tool:use` event.
 *
 * Claude's AskUserQuestion input looks like:
 *   { questions: [{ question, header?, multiSelect?, options: [{ label, description? }] }] }
 *
 * Some older variants pass `{ question, options }` at the top level; both are
 * accepted here so the runtime event stays stable across SDK/CLI versions.
 *
 * Adapters for other providers (Codex, OpenRouter, future runtimes) should
 * implement their own parser function returning the same payload shape, then
 * feed the result into the runtime-neutral `buildToolUseEvents` helper.
 */
export function parseClaudeAskUserQuestion(
  toolName: string,
  toolUseId: string | null,
  input: unknown,
): RuntimeToolQuestionPayload | null {
  if (toolName !== "AskUserQuestion") return null;
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!record) return null;

  const rawQuestions: Record<string, unknown>[] = Array.isArray(record.questions)
    ? (record.questions as unknown[]).filter(
        (entry): entry is Record<string, unknown> => entry != null && typeof entry === "object",
      )
    : [record];

  const questions = rawQuestions
    .map((entry) => normalizeQuestion(entry))
    .filter((entry): entry is RuntimeToolQuestionPayload["questions"][number] => entry !== null);

  if (questions.length === 0) return null;

  return {
    toolUseId,
    toolName,
    questions,
  };
}

function normalizeQuestion(
  record: Record<string, unknown>,
): RuntimeToolQuestionPayload["questions"][number] | null {
  const question =
    (typeof record.question === "string" && record.question) ||
    (typeof record.prompt === "string" && record.prompt) ||
    null;
  const rawOptions = Array.isArray(record.options) ? (record.options as unknown[]) : [];
  const options = rawOptions
    .map((entry) => normalizeOption(entry))
    .filter(
      (entry): entry is RuntimeToolQuestionPayload["questions"][number]["options"][number] =>
        entry !== null,
    );
  if (!question && options.length === 0) return null;
  return {
    question: question ?? "",
    header: typeof record.header === "string" ? record.header : undefined,
    multiSelect: typeof record.multiSelect === "boolean" ? record.multiSelect : undefined,
    options,
  };
}

function normalizeOption(
  entry: unknown,
): RuntimeToolQuestionPayload["questions"][number]["options"][number] | null {
  if (typeof entry === "string") {
    return { label: entry };
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const label =
      (typeof record.label === "string" && record.label) ||
      (typeof record.title === "string" && record.title) ||
      (typeof record.value === "string" && record.value) ||
      (typeof record.text === "string" && record.text) ||
      null;
    if (!label) return null;
    return {
      label,
      description: typeof record.description === "string" ? record.description : undefined,
    };
  }
  return null;
}
