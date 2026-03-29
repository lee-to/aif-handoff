import { describe, it, expect } from "vitest";
import { isExternalFailure, isFastRetryableFailure, truncateReason } from "../errorClassifier.js";

describe("isExternalFailure", () => {
  it.each([
    "not logged in to Claude",
    "Usage limit exceeded",
    "You're out of extra usage · resets 3pm",
    "Rate limit reached",
    "Insufficient quota remaining",
    "No credits available",
    "Process exited with code 1",
    "Request timed out",
    "Claude stream interrupted",
    "WebSocket stream closed",
    "Error in hook callback",
    "Permission denied: /etc/shadow",
    "Blocked by permissions",
    "No write permission for directory",
  ])("returns true for external error: %s", (message) => {
    expect(isExternalFailure(new Error(message))).toBe(true);
  });

  it("returns true for string errors", () => {
    expect(isExternalFailure("rate limit hit")).toBe(true);
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
