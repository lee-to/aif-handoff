import { describe, expect, it } from "vitest";
import {
  classifyClaudeResultSubtype,
  classifyClaudeRuntimeError,
  ClaudeRuntimeAdapterError,
} from "../adapters/claude/errors.js";
import {
  RuntimeLimitPrecision,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  RuntimeLimitScope,
} from "../types.js";

describe("Claude runtime error classification", () => {
  it("classifies usage-limit failures", () => {
    const classified = classifyClaudeRuntimeError("Out of extra usage for this account");
    expect(classified).toBeInstanceOf(ClaudeRuntimeAdapterError);
    expect(classified.adapterCode).toBe("CLAUDE_USAGE_LIMIT");
  });

  it.each([
    "You've hit your limit · resets 5pm (Europe/Berlin)",
    "Limit reached for claude-opus-4",
    "Daily limit exceeded",
  ])("classifies Claude limit phrasings: %s", (msg) => {
    const classified = classifyClaudeRuntimeError(msg);
    expect(classified.adapterCode).toBe("CLAUDE_USAGE_LIMIT");
    expect(classified.category).toBe("rate_limit");
  });

  it("classifies permission failures", () => {
    const classified = classifyClaudeRuntimeError(new Error("write permission denied"));
    expect(classified.adapterCode).toBe("CLAUDE_PERMISSION_DENIED");
  });

  it("classifies auth failures", () => {
    const classified = classifyClaudeRuntimeError(
      new Error("Failed to authenticate. API Error: 401 authentication_error"),
    );
    expect(classified.adapterCode).toBe("CLAUDE_AUTH_ERROR");
    expect(classified.category).toBe("auth");
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

  it("classifies unknown failures with blocked limit metadata as rate limits", () => {
    const resetAt = "2026-04-30T21:20:00.000Z";
    const classified = classifyClaudeRuntimeError(
      new Error("Claude CLI exited with code 1: unknown error"),
      undefined,
      {
        resetAt,
        limitSnapshot: {
          source: RuntimeLimitSource.SDK_EVENT,
          status: RuntimeLimitStatus.BLOCKED,
          precision: RuntimeLimitPrecision.HEURISTIC,
          checkedAt: "2026-04-30T17:01:13.958Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-1",
          primaryScope: RuntimeLimitScope.SPEND,
          resetAt,
          windows: [],
        },
      },
    );

    expect(classified.adapterCode).toBe("CLAUDE_USAGE_LIMIT");
    expect(classified.category).toBe("rate_limit");
    expect(classified.resetAt).toBe(resetAt);
  });

  it("classifies non-success result subtype", () => {
    const classified = classifyClaudeResultSubtype("tool_failed");
    expect(classified.message).toContain("tool_failed");
    expect(classified.adapterCode).toBe("CLAUDE_RUNTIME_ERROR");
  });

  it("does not re-wrap existing claude adapter errors", () => {
    const original = new ClaudeRuntimeAdapterError(
      "Failed to authenticate",
      "CLAUDE_AUTH_ERROR",
      "auth",
    );
    const classified = classifyClaudeRuntimeError(original);
    expect(classified).toBe(original);
  });

  it("includes result detail for non-success subtype classification", () => {
    const classified = classifyClaudeResultSubtype(
      "error_during_execution",
      "No conversation found with session ID: dead-session",
    );
    expect(classified.message).toContain("error_during_execution");
    expect(classified.message).toContain("No conversation found with session ID");
  });

  // HTTP status classification
  it("classifies by HTTP status 429 as rate_limit", () => {
    const classified = classifyClaudeRuntimeError(new Error("response body"), 429);
    expect(classified.adapterCode).toBe("CLAUDE_USAGE_LIMIT");
    expect(classified.category).toBe("rate_limit");
  });

  it("classifies by HTTP status 401 as auth", () => {
    const classified = classifyClaudeRuntimeError(new Error("response body"), 401);
    expect(classified.adapterCode).toBe("CLAUDE_AUTH_ERROR");
    expect(classified.category).toBe("auth");
  });

  it("classifies by HTTP status 500 as transport", () => {
    const classified = classifyClaudeRuntimeError(new Error("server error"), 500);
    expect(classified.adapterCode).toBe("CLAUDE_TRANSPORT_ERROR");
    expect(classified.category).toBe("transport");
  });

  it("prefers HTTP status over message", () => {
    const classified = classifyClaudeRuntimeError(new Error("rate limit"), 401);
    expect(classified.category).toBe("auth");
  });

  it("falls back to message when HTTP status is unrecognized", () => {
    const classified = classifyClaudeRuntimeError(new Error("rate limit"), 200);
    expect(classified.category).toBe("rate_limit");
  });
});
