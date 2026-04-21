import { describe, expect, it } from "vitest";
import { parseClaudeAskUserQuestion } from "../adapters/claude/questions.js";
import { toolQuestionEvent } from "../toolEvents.js";

describe("parseClaudeAskUserQuestion", () => {
  it("returns null for tools other than AskUserQuestion", () => {
    expect(parseClaudeAskUserQuestion("Bash", "t-1", { command: "ls" })).toBeNull();
  });

  it("returns null when input is not an object", () => {
    expect(parseClaudeAskUserQuestion("AskUserQuestion", "t-1", "nope")).toBeNull();
    expect(parseClaudeAskUserQuestion("AskUserQuestion", "t-1", null)).toBeNull();
  });

  it("parses the real Claude Code shape with a questions array", () => {
    const payload = parseClaudeAskUserQuestion("AskUserQuestion", "tool-42", {
      questions: [
        {
          question: "Which planner mode?",
          header: "Planning",
          multiSelect: false,
          options: [{ label: "Fast", description: "quick path" }, { label: "Full" }],
        },
      ],
    });
    expect(payload).toEqual({
      toolUseId: "tool-42",
      toolName: "AskUserQuestion",
      questions: [
        {
          question: "Which planner mode?",
          header: "Planning",
          multiSelect: false,
          options: [{ label: "Fast", description: "quick path" }, { label: "Full" }],
        },
      ],
    });
  });

  it("accepts the legacy flat shape { question, options }", () => {
    const payload = parseClaudeAskUserQuestion("AskUserQuestion", null, {
      question: "Proceed?",
      options: ["Yes", "No"],
    });
    expect(payload?.questions).toEqual([
      {
        question: "Proceed?",
        header: undefined,
        multiSelect: undefined,
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ]);
    expect(payload?.toolUseId).toBeNull();
  });

  it("drops options with no recognizable label", () => {
    const payload = parseClaudeAskUserQuestion("AskUserQuestion", "x", {
      question: "Pick one",
      options: [{ label: "A" }, { foo: "bar" }, 42],
    });
    expect(payload?.questions[0].options).toEqual([{ label: "A" }]);
  });

  it("returns null when neither a question nor options can be extracted", () => {
    expect(parseClaudeAskUserQuestion("AskUserQuestion", "x", { foo: "bar" })).toBeNull();
  });

  it("builds a tool:question runtime event from the payload", () => {
    const payload = parseClaudeAskUserQuestion("AskUserQuestion", "t-1", {
      question: "Ready?",
      options: ["Yes"],
    });
    expect(payload).not.toBeNull();
    const event = toolQuestionEvent(payload!, "2026-04-14T00:00:00.000Z");
    expect(event.type).toBe("tool:question");
    expect(event.timestamp).toBe("2026-04-14T00:00:00.000Z");
    expect(event.message).toBe("Ready?");
    expect(event.data).toBe(payload as unknown as Record<string, unknown>);
  });
});
