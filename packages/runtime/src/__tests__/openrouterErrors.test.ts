import { describe, expect, it } from "vitest";
import {
  classifyOpenRouterRuntimeError,
  OpenRouterRuntimeAdapterError,
} from "../adapters/openrouter/errors.js";
import { RuntimeExecutionError } from "../errors.js";

describe("classifyOpenRouterRuntimeError", () => {
  it("extends RuntimeExecutionError", () => {
    const error = classifyOpenRouterRuntimeError(new Error("test"));
    expect(error).toBeInstanceOf(RuntimeExecutionError);
    expect(error).toBeInstanceOf(OpenRouterRuntimeAdapterError);
    expect(error.name).toBe("OpenRouterRuntimeAdapterError");
  });

  it("preserves original error as cause", () => {
    const original = new Error("original");
    const classified = classifyOpenRouterRuntimeError(original);
    expect(classified.cause).toBe(original);
  });

  it("does not re-wrap existing OpenRouterRuntimeAdapterError", () => {
    const original = new OpenRouterRuntimeAdapterError(
      "rate limit",
      "OPENROUTER_RATE_LIMIT",
      "rate_limit",
    );
    const classified = classifyOpenRouterRuntimeError(original);
    expect(classified).toBe(original);
  });

  it("handles non-Error values", () => {
    const classified = classifyOpenRouterRuntimeError("string error");
    expect(classified.message).toBe("string error");
    expect(classified.adapterCode).toBe("OPENROUTER_RUNTIME_ERROR");
  });

  // Rate limit (message-based fallback)
  it.each([
    "rate limit exceeded",
    "rate_limit reached",
    "too many requests",
    "insufficient_quota",
    "quota exceeded",
    "You've hit your limit",
    "Limit reached for the day",
    "Limit exceeded",
    "Out of credits",
  ])("classifies rate limit by message: %s", (msg) => {
    const err = classifyOpenRouterRuntimeError(new Error(msg));
    expect(err.adapterCode).toBe("OPENROUTER_RATE_LIMIT");
    expect(err.category).toBe("rate_limit");
  });

  // Rate limit (HTTP status-based — the correct way)
  it("classifies HTTP 429 as rate_limit via status", () => {
    const err = classifyOpenRouterRuntimeError(new Error("response body"), 429);
    expect(err.adapterCode).toBe("OPENROUTER_RATE_LIMIT");
    expect(err.category).toBe("rate_limit");
  });

  // Auth (message-based fallback)
  it.each([
    "Unauthorized access",
    "Invalid API key provided",
    "invalid_api_key",
    "Forbidden resource",
  ])("classifies auth error by message: %s", (msg) => {
    const err = classifyOpenRouterRuntimeError(new Error(msg));
    expect(err.adapterCode).toBe("OPENROUTER_AUTH_ERROR");
    expect(err.category).toBe("auth");
  });

  // Auth (HTTP status-based — the correct way)
  it("classifies HTTP 401 as auth via status", () => {
    const err = classifyOpenRouterRuntimeError(new Error("response body"), 401);
    expect(err.adapterCode).toBe("OPENROUTER_AUTH_ERROR");
    expect(err.category).toBe("auth");
  });

  it("classifies HTTP 403 as auth via status", () => {
    const err = classifyOpenRouterRuntimeError(new Error("response body"), 403);
    expect(err.adapterCode).toBe("OPENROUTER_AUTH_ERROR");
    expect(err.category).toBe("auth");
  });

  // Timeout
  it.each(["Request timed out", "Connection timeout", "ETIMEDOUT"])(
    "classifies timeout: %s",
    (msg) => {
      const err = classifyOpenRouterRuntimeError(new Error(msg));
      expect(err.adapterCode).toBe("OPENROUTER_TIMEOUT");
      expect(err.category).toBe("timeout");
    },
  );

  // Model not found
  it.each([
    "model not found",
    "no endpoints found for this model",
    "model_not_available",
    "no available model provider",
  ])("classifies model not found: %s", (msg) => {
    const err = classifyOpenRouterRuntimeError(new Error(msg));
    expect(err.adapterCode).toBe("OPENROUTER_MODEL_NOT_FOUND");
    expect(err.category).toBe("model_not_found");
  });

  // Context length
  it.each(["context_length_exceeded", "maximum context length is 4096"])(
    "classifies context length: %s",
    (msg) => {
      const err = classifyOpenRouterRuntimeError(new Error(msg));
      expect(err.adapterCode).toBe("OPENROUTER_CONTEXT_LENGTH");
      expect(err.category).toBe("context_length");
    },
  );

  // Content filter
  it.each(["content_filter triggered", "content_policy violation"])(
    "classifies content filter: %s",
    (msg) => {
      const err = classifyOpenRouterRuntimeError(new Error(msg));
      expect(err.adapterCode).toBe("OPENROUTER_CONTENT_FILTER");
      expect(err.category).toBe("content_filter");
    },
  );

  // Transport
  it.each(["Connection refused", "ECONNREFUSED", "Network error", "fetch failed"])(
    "classifies transport error: %s",
    (msg) => {
      const err = classifyOpenRouterRuntimeError(new Error(msg));
      expect(err.adapterCode).toBe("OPENROUTER_TRANSPORT_ERROR");
      expect(err.category).toBe("transport");
    },
  );

  // Fallback
  it("falls back to OPENROUTER_RUNTIME_ERROR for unknown errors", () => {
    const err = classifyOpenRouterRuntimeError(new Error("something unexpected"));
    expect(err.adapterCode).toBe("OPENROUTER_RUNTIME_ERROR");
    expect(err.category).toBe("unknown");
  });

  // HTTP status classification
  it("classifies by HTTP status 429 as rate_limit", () => {
    const err = classifyOpenRouterRuntimeError(new Error("some response body"), 429);
    expect(err.adapterCode).toBe("OPENROUTER_RATE_LIMIT");
    expect(err.category).toBe("rate_limit");
  });

  it("classifies by HTTP status 401 as auth", () => {
    const err = classifyOpenRouterRuntimeError(new Error("some response body"), 401);
    expect(err.adapterCode).toBe("OPENROUTER_AUTH_ERROR");
    expect(err.category).toBe("auth");
  });

  it("falls through to message fallback for HTTP 404 (not in shared status map)", () => {
    const err = classifyOpenRouterRuntimeError(new Error("model not found"), 404);
    expect(err.adapterCode).toBe("OPENROUTER_MODEL_NOT_FOUND");
    expect(err.category).toBe("model_not_found");
  });

  it("classifies HTTP 404 with generic body as unknown", () => {
    const err = classifyOpenRouterRuntimeError(new Error("some response body"), 404);
    expect(err.category).toBe("unknown");
  });

  it("classifies by HTTP status 500 as transport", () => {
    const err = classifyOpenRouterRuntimeError(new Error("some response body"), 500);
    expect(err.adapterCode).toBe("OPENROUTER_TRANSPORT_ERROR");
    expect(err.category).toBe("transport");
  });

  it("falls back to message when HTTP status is unrecognized", () => {
    const err = classifyOpenRouterRuntimeError(new Error("rate limit exceeded"), 200);
    expect(err.adapterCode).toBe("OPENROUTER_RATE_LIMIT");
    expect(err.category).toBe("rate_limit");
  });

  it("prefers HTTP status over message classification", () => {
    // Message says "rate limit" but status says 401 (auth)
    const err = classifyOpenRouterRuntimeError(new Error("rate limit reached"), 401);
    expect(err.category).toBe("auth");
  });
});
