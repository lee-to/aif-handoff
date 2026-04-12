import { describe, expect, it } from "vitest";
import { CodexRuntimeAdapterError, classifyCodexRuntimeError } from "../adapters/codex/errors.js";

describe("codex error classification", () => {
  it("returns existing CodexRuntimeAdapterError without re-wrapping", () => {
    const original = new CodexRuntimeAdapterError(
      "OpenAI API HTTP 500: Internal server error",
      "CODEX_RUNTIME_ERROR",
      "unknown",
    );

    const classified = classifyCodexRuntimeError(original);
    expect(classified).toBe(original);
  });

  it("does not classify OpenAI 500 websocket failures as auth", () => {
    const classified = classifyCodexRuntimeError(
      "failed to connect to websocket: HTTP error: 500 Internal Server Error, url: wss://api.openai.com/v1/responses",
    );
    expect(classified.adapterCode).toBe("CODEX_RUNTIME_ERROR");
    expect(classified.category).toBe("unknown");
  });

  it("classifies explicit 401 failures as auth", () => {
    const classified = classifyCodexRuntimeError("OpenAI API HTTP 401: invalid api key");
    expect(classified.adapterCode).toBe("CODEX_AUTH_ERROR");
    expect(classified.category).toBe("auth");
  });

  it("classifies model capacity failures as rate limit", () => {
    const classified = classifyCodexRuntimeError(
      "Selected model is at capacity. Please try a different model",
    );
    expect(classified.adapterCode).toBe("CODEX_RATE_LIMIT");
    expect(classified.category).toBe("rate_limit");
  });

  it.each([
    "You've hit your limit, resets later today",
    "Monthly limit reached",
    "Limit exceeded for this model",
    "Out of credits",
  ])("classifies provider limit phrasings as rate limit: %s", (msg) => {
    const classified = classifyCodexRuntimeError(msg);
    expect(classified.adapterCode).toBe("CODEX_RATE_LIMIT");
    expect(classified.category).toBe("rate_limit");
  });

  // HTTP status classification
  it("classifies by HTTP status 429 as rate_limit", () => {
    const classified = classifyCodexRuntimeError(new Error("response body"), 429);
    expect(classified.adapterCode).toBe("CODEX_RATE_LIMIT");
    expect(classified.category).toBe("rate_limit");
  });

  it("classifies by HTTP status 401 as auth", () => {
    const classified = classifyCodexRuntimeError(new Error("response body"), 401);
    expect(classified.adapterCode).toBe("CODEX_AUTH_ERROR");
    expect(classified.category).toBe("auth");
  });

  it("classifies by HTTP status 500 as transport", () => {
    const classified = classifyCodexRuntimeError(new Error("internal server error"), 500);
    expect(classified.adapterCode).toBe("CODEX_TRANSPORT_ERROR");
    expect(classified.category).toBe("transport");
  });

  it("prefers HTTP status over message classification", () => {
    const classified = classifyCodexRuntimeError(new Error("rate limit"), 401);
    expect(classified.category).toBe("auth");
  });

  it("falls back to message when HTTP status is unrecognized", () => {
    const classified = classifyCodexRuntimeError(new Error("rate limit exceeded"), 200);
    expect(classified.category).toBe("rate_limit");
  });

  it("classifies transport errors with category transport", () => {
    const classified = classifyCodexRuntimeError(new Error("connection refused"));
    expect(classified.adapterCode).toBe("CODEX_TRANSPORT_ERROR");
    expect(classified.category).toBe("transport");
  });
});
