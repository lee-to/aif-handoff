import { describe, expect, it } from "vitest";
import { isValidTrustToken, RUNTIME_TRUST_TOKEN } from "../trust.js";

describe("RUNTIME_TRUST_TOKEN", () => {
  it("is a symbol", () => {
    expect(typeof RUNTIME_TRUST_TOKEN).toBe("symbol");
  });

  it("is stable across imports (Symbol.for)", () => {
    expect(RUNTIME_TRUST_TOKEN).toBe(Symbol.for("aif.runtime.trust"));
  });
});

describe("isValidTrustToken", () => {
  it("returns true for the correct token", () => {
    expect(isValidTrustToken(RUNTIME_TRUST_TOKEN)).toBe(true);
  });

  it("returns true for Symbol.for with same key", () => {
    expect(isValidTrustToken(Symbol.for("aif.runtime.trust"))).toBe(true);
  });

  it("returns false for a different symbol", () => {
    expect(isValidTrustToken(Symbol("aif.runtime.trust"))).toBe(false);
  });

  it("returns false for boolean true", () => {
    expect(isValidTrustToken(true)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isValidTrustToken("aif.runtime.trust")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isValidTrustToken(null)).toBe(false);
    expect(isValidTrustToken(undefined)).toBe(false);
  });
});
