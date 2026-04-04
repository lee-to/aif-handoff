import { describe, expect, it } from "vitest";
import {
  classifyClaudeResultSubtype,
  classifyClaudeRuntimeError,
  ClaudeRuntimeAdapterError,
} from "../adapters/claude/errors.js";

describe("Claude runtime error classification", () => {
  it("classifies usage-limit failures", () => {
    const classified = classifyClaudeRuntimeError("Out of extra usage for this account");
    expect(classified).toBeInstanceOf(ClaudeRuntimeAdapterError);
    expect(classified.adapterCode).toBe("CLAUDE_USAGE_LIMIT");
  });

  it("classifies permission failures", () => {
    const classified = classifyClaudeRuntimeError(new Error("write permission denied"));
    expect(classified.adapterCode).toBe("CLAUDE_PERMISSION_DENIED");
  });

  it("classifies query start timeout failures", () => {
    const classified = classifyClaudeRuntimeError("query_start_timeout while waiting for output");
    expect(classified.adapterCode).toBe("CLAUDE_QUERY_START_TIMEOUT");
  });

  it("classifies stream failures", () => {
    const classified = classifyClaudeRuntimeError("stream closed unexpectedly");
    expect(classified.adapterCode).toBe("CLAUDE_STREAM_ERROR");
  });

  it("classifies unknown failures with default code", () => {
    const classified = classifyClaudeRuntimeError({ message: "unexpected" });
    expect(classified.adapterCode).toBe("CLAUDE_RUNTIME_ERROR");
  });

  it("classifies non-success result subtype", () => {
    const classified = classifyClaudeResultSubtype("tool_failed");
    expect(classified.message).toContain("tool_failed");
    expect(classified.adapterCode).toBe("CLAUDE_RUNTIME_ERROR");
  });

  it("includes result detail for non-success subtype classification", () => {
    const classified = classifyClaudeResultSubtype(
      "error_during_execution",
      "No conversation found with session ID: dead-session",
    );
    expect(classified.message).toContain("error_during_execution");
    expect(classified.message).toContain("No conversation found with session ID");
  });
});
