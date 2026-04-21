import { describe, expect, it } from "vitest";
import { buildToolUseEvents, toolQuestionEvent } from "../toolEvents.js";
import type { RuntimeToolQuestionPayload } from "../types.js";

describe("buildToolUseEvents", () => {
  it("emits a single tool:use event when no questionPayload is provided", () => {
    const events = buildToolUseEvents({
      toolName: "Bash",
      toolUseId: "t-1",
      input: { command: "ls" },
      timestamp: "2026-04-14T00:00:00.000Z",
      detailSuffix: " `ls`",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool:use",
      message: "Bash `ls`",
      data: { name: "Bash", input: { command: "ls" }, id: "t-1", interactive: false },
    });
  });

  it("emits tool:use + tool:question when a payload is provided", () => {
    const payload: RuntimeToolQuestionPayload = {
      toolUseId: "t-2",
      toolName: "AskUserQuestion",
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
    };
    const events = buildToolUseEvents({
      toolName: "AskUserQuestion",
      toolUseId: "t-2",
      input: {},
      timestamp: "2026-04-14T00:00:00.000Z",
      questionPayload: payload,
    });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("tool:use");
    expect((events[0].data as { interactive: boolean }).interactive).toBe(true);
    expect(events[1].type).toBe("tool:question");
    expect(events[1].data).toBe(payload);
    // Both events share the same timestamp so consumers can correlate them.
    expect(events[0].timestamp).toBe(events[1].timestamp);
  });

  it("treats null questionPayload the same as omitted", () => {
    const events = buildToolUseEvents({
      toolName: "Write",
      toolUseId: null,
      input: { file_path: "/tmp/foo" },
      timestamp: "2026-04-14T00:00:00.000Z",
      questionPayload: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0].data?.id).toBeNull();
  });
});

describe("toolQuestionEvent", () => {
  it("joins all question texts so the message is a useful fallback, not just the first one", () => {
    const payload: RuntimeToolQuestionPayload = {
      toolUseId: null,
      toolName: "AskUserQuestion",
      questions: [
        { question: "First?", options: [] },
        { question: "Second?", options: [] },
      ],
    };
    const event = toolQuestionEvent(payload, "2026-04-14T00:00:00.000Z");
    expect(event.type).toBe("tool:question");
    expect(event.message).toBe("First? | Second?");
  });

  it("falls back to the tool name when no question text is present", () => {
    const payload: RuntimeToolQuestionPayload = {
      toolUseId: null,
      toolName: "AskUserQuestion",
      questions: [{ question: "", options: [{ label: "Only" }] }],
    };
    const event = toolQuestionEvent(payload, "2026-04-14T00:00:00.000Z");
    expect(event.message).toBe("AskUserQuestion");
  });

  it("preserves the full payload in event.data so consumers can render header + options", () => {
    const payload: RuntimeToolQuestionPayload = {
      toolUseId: "t-99",
      toolName: "AskUserQuestion",
      questions: [
        {
          question: "Branch?",
          header: "Deploy target",
          options: [{ label: "main" }, { label: "dev" }],
        },
      ],
    };
    const event = toolQuestionEvent(payload, "2026-04-14T00:00:00.000Z");
    expect(event.data).toBe(payload as unknown as Record<string, unknown>);
  });
});
