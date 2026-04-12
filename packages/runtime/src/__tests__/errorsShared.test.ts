import { describe, expect, it } from "vitest";
import {
  classifyByHttpStatus,
  classifyByMessageFallback,
  isExternalFailureCategory,
  isRuntimeErrorCategory,
  RuntimeExecutionError,
  type RuntimeErrorCategory,
} from "../errors.js";

describe("classifyByHttpStatus", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [408, "timeout"],
    [504, "timeout"],
    [413, "context_length"],
    [451, "content_filter"],
  ] as Array<[number, RuntimeErrorCategory]>)("maps status %d → %s", (status, expected) => {
    expect(classifyByHttpStatus(status)).toBe(expected);
  });

  it.each([500, 502, 503])("maps 5xx status %d → transport", (status) => {
    expect(classifyByHttpStatus(status)).toBe("transport");
  });

  it("returns null for 200 (success status)", () => {
    expect(classifyByHttpStatus(200)).toBeNull();
  });

  it("returns null for 201 (created)", () => {
    expect(classifyByHttpStatus(201)).toBeNull();
  });

  it("returns null for 400 (bad request, not in map)", () => {
    expect(classifyByHttpStatus(400)).toBeNull();
  });

  it("returns null for 404 (too broad for shared mapping)", () => {
    expect(classifyByHttpStatus(404)).toBeNull();
  });

  it("returns null for 0", () => {
    expect(classifyByHttpStatus(0)).toBeNull();
  });
});

describe("classifyByMessageFallback", () => {
  it.each([
    ["Usage limit exceeded", "rate_limit"],
    ["rate limit reached", "rate_limit"],
    ["Too many requests", "rate_limit"],
    ["You've hit your limit", "rate_limit"],
    ["Out of credits", "rate_limit"],
    ["quota exceeded", "rate_limit"],
    ["authentication_error", "auth"],
    ["unauthorized", "auth"],
    ["invalid api key", "auth"],
    ["forbidden", "auth"],
    ["not logged in", "auth"],
    ["request timed out", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["query_start_timeout", "timeout"],
    ["permission denied", "permission"],
    ["blocked by permissions", "permission"],
    ["stream closed", "stream"],
    ["stream interrupted", "stream"],
    ["connection refused", "transport"],
    ["ECONNREFUSED", "transport"],
    ["fetch failed", "transport"],
    ["model not found", "model_not_found"],
    ["no endpoints found", "model_not_found"],
    ["context_length_exceeded", "context_length"],
    ["content_filter triggered", "content_filter"],
  ] as Array<[string, RuntimeErrorCategory]>)("classifies %s → %s", (message, expected) => {
    expect(classifyByMessageFallback(message)).toBe(expected);
  });

  it("returns unknown for unrecognized messages", () => {
    expect(classifyByMessageFallback("something unexpected happened")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyByMessageFallback("RATE LIMIT EXCEEDED")).toBe("rate_limit");
    expect(classifyByMessageFallback("Unauthorized")).toBe("auth");
  });
});

describe("isExternalFailureCategory", () => {
  it.each([
    "rate_limit",
    "auth",
    "timeout",
    "permission",
    "stream",
    "transport",
  ] as RuntimeErrorCategory[])("returns true for external category: %s", (category) => {
    expect(isExternalFailureCategory(category)).toBe(true);
  });

  it.each([
    "unknown",
    "model_not_found",
    "context_length",
    "content_filter",
  ] as RuntimeErrorCategory[])("returns false for non-external category: %s", (category) => {
    expect(isExternalFailureCategory(category)).toBe(false);
  });
});

describe("isRuntimeErrorCategory", () => {
  it("returns true for matching category", () => {
    const err = new RuntimeExecutionError("test", undefined, "rate_limit");
    expect(isRuntimeErrorCategory(err, "rate_limit")).toBe(true);
  });

  it("returns false for non-matching category", () => {
    const err = new RuntimeExecutionError("test", undefined, "rate_limit");
    expect(isRuntimeErrorCategory(err, "auth")).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isRuntimeErrorCategory(new Error("test"), "rate_limit")).toBe(false);
  });

  it("returns false for non-Error", () => {
    expect(isRuntimeErrorCategory("string", "rate_limit")).toBe(false);
    expect(isRuntimeErrorCategory(null, "rate_limit")).toBe(false);
  });
});
