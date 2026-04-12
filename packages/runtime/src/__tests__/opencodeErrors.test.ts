import { describe, expect, it } from "vitest";
import { classifyOpenCodeRuntimeError } from "../adapters/opencode/errors.js";

describe("OpenCode error classification", () => {
  it("classifies auth errors", () => {
    const error = classifyOpenCodeRuntimeError(new Error("401 unauthorized"));
    expect(error.adapterCode).toBe("OPENCODE_AUTH_ERROR");
    expect(error.category).toBe("auth");
  });

  it("classifies rate limit errors", () => {
    const error = classifyOpenCodeRuntimeError(new Error("429 rate limit exceeded"));
    expect(error.adapterCode).toBe("OPENCODE_RATE_LIMIT");
    expect(error.category).toBe("rate_limit");
  });

  it.each([
    "You've hit your limit · resets 5pm",
    "Limit reached for this account",
    "Limit exceeded",
    "Out of credits",
  ])("classifies provider limit phrasings as rate limit: %s", (msg) => {
    const error = classifyOpenCodeRuntimeError(new Error(msg));
    expect(error.adapterCode).toBe("OPENCODE_RATE_LIMIT");
    expect(error.category).toBe("rate_limit");
  });

  it("classifies timeout errors", () => {
    const error = classifyOpenCodeRuntimeError(new Error("request timeout"));
    expect(error.adapterCode).toBe("OPENCODE_TIMEOUT");
    expect(error.category).toBe("timeout");
  });

  it("classifies network errors with category transport", () => {
    const error = classifyOpenCodeRuntimeError(new Error("connection refused"));
    expect(error.adapterCode).toBe("OPENCODE_TRANSPORT_ERROR");
    expect(error.category).toBe("transport");
  });

  it("classifies session errors", () => {
    const error = classifyOpenCodeRuntimeError(new Error("session not found"));
    expect(error.adapterCode).toBe("OPENCODE_SESSION_ERROR");
  });

  it("classifies provider/model errors with category model_not_found", () => {
    const error = classifyOpenCodeRuntimeError(
      new Error("ProviderModelNotFoundError: provider not found"),
    );
    expect(error.adapterCode).toBe("OPENCODE_MODEL_ERROR");
    expect(error.category).toBe("model_not_found");
  });

  it("falls back to generic runtime error", () => {
    const error = classifyOpenCodeRuntimeError(new Error("unexpected"));
    expect(error.adapterCode).toBe("OPENCODE_RUNTIME_ERROR");
    expect(error.category).toBe("unknown");
  });

  // HTTP status classification
  it("classifies by HTTP status 429 as rate_limit", () => {
    const error = classifyOpenCodeRuntimeError(new Error("response body"), 429);
    expect(error.adapterCode).toBe("OPENCODE_RATE_LIMIT");
    expect(error.category).toBe("rate_limit");
  });

  it("classifies by HTTP status 401 as auth", () => {
    const error = classifyOpenCodeRuntimeError(new Error("response body"), 401);
    expect(error.adapterCode).toBe("OPENCODE_AUTH_ERROR");
    expect(error.category).toBe("auth");
  });

  it("classifies by HTTP status 500 as transport", () => {
    const error = classifyOpenCodeRuntimeError(new Error("server error"), 500);
    expect(error.adapterCode).toBe("OPENCODE_TRANSPORT_ERROR");
    expect(error.category).toBe("transport");
  });

  it("prefers HTTP status over message", () => {
    const error = classifyOpenCodeRuntimeError(new Error("rate limit"), 401);
    expect(error.category).toBe("auth");
  });

  it("preserves httpStatus on classified error", () => {
    const error = classifyOpenCodeRuntimeError(new Error("not found"), 404);
    expect(error.httpStatus).toBe(404);
  });

  it("httpStatus is undefined when not provided", () => {
    const error = classifyOpenCodeRuntimeError(new Error("timeout"));
    expect(error.httpStatus).toBeUndefined();
  });
});
