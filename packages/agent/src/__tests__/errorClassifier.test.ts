import { describe, it, expect } from "vitest";
import { RuntimeExecutionError } from "@aif/runtime";
import { isExternalFailure, isFastRetryableFailure, truncateReason } from "../errorClassifier.js";

describe("isExternalFailure", () => {
  // Primary path: RuntimeExecutionError with structured category
  it.each([
    ["rate_limit", true],
    ["auth", true],
    ["timeout", true],
    ["permission", true],
    ["stream", true],
    ["transport", true],
    ["unknown", false],
    ["model_not_found", false],
    ["context_length", false],
    ["content_filter", false],
  ] as Array<[string, boolean]>)(
    "returns %s for RuntimeExecutionError with category %s",
    (category, expected) => {
      const err = new RuntimeExecutionError(
        "test error",
        undefined,
        category as import("@aif/runtime").RuntimeErrorCategory,
      );
      expect(isExternalFailure(err)).toBe(expected);
    },
  );

  // Secondary path: capability errors (not RuntimeExecutionError)
  it.each([
    "runtime capability check failed",
    "required capabilities not met",
    "unsupported capabilities for this adapter",
  ])("returns true for capability error message: %s", (message) => {
    expect(isExternalFailure(new Error(message))).toBe(true);
  });

  // Plain errors without category are NOT classified as external
  it("returns false for plain Error with external-sounding message", () => {
    expect(isExternalFailure(new Error("rate limit hit"))).toBe(false);
  });

  it("unwraps RuntimeExecutionError from error causes", () => {
    const err = new Error("wrapped", {
      cause: new RuntimeExecutionError("rate limited", undefined, "rate_limit"),
    });
    expect(isExternalFailure(err)).toBe(true);
  });

  it("returns false for internal errors", () => {
    expect(isExternalFailure(new Error("Cannot read property 'foo' of undefined"))).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isExternalFailure(new Error("Something went wrong"))).toBe(false);
  });

  it("handles non-Error non-string values", () => {
    expect(isExternalFailure(42)).toBe(false);
    expect(isExternalFailure(null)).toBe(false);
  });
});

describe("isFastRetryableFailure", () => {
  it("returns true for stream interruption before worker dispatch", () => {
    expect(
      isFastRetryableFailure(new Error("stream interrupted before implement-worker dispatch")),
    ).toBe(true);
  });

  it("returns true for hook callback with stream closed", () => {
    expect(
      isFastRetryableFailure(new Error("Error in hook callback: stream closed unexpectedly")),
    ).toBe(true);
  });

  it("returns false for regular stream closed (not hook callback)", () => {
    expect(isFastRetryableFailure(new Error("stream closed"))).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isFastRetryableFailure(new Error("file not found"))).toBe(false);
  });
});

describe("truncateReason", () => {
  it("returns short strings unchanged", () => {
    expect(truncateReason("short")).toBe("short");
  });

  it("truncates long strings with ellipsis", () => {
    const long = "x".repeat(300);
    const result = truncateReason(long);
    expect(result.length).toBe(240);
    expect(result.endsWith("...")).toBe(true);
  });

  it("respects custom maxLength", () => {
    const result = truncateReason("a".repeat(50), 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns string at exact maxLength unchanged", () => {
    const exact = "x".repeat(240);
    expect(truncateReason(exact)).toBe(exact);
  });
});
