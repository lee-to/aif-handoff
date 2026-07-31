import { describe, it, expect, afterEach, vi } from "vitest";
import { internalBroadcastHeaders } from "../internalBroadcast.js";

describe("internalBroadcastHeaders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the configured token in both accepted header forms", () => {
    expect(internalBroadcastHeaders("internal-token")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer internal-token",
      "X-Internal-Broadcast-Token": "internal-token",
    });
  });

  it("trims surrounding whitespace from the token", () => {
    expect(internalBroadcastHeaders("  padded  ")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer padded",
      "X-Internal-Broadcast-Token": "padded",
    });
  });

  it("falls back to the loopback caller header in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(internalBroadcastHeaders(undefined)).toEqual({
      "Content-Type": "application/json",
      "X-Real-IP": "127.0.0.1",
    });
  });

  it("sends no auth hint without a token outside development", () => {
    vi.stubEnv("NODE_ENV", "");

    // internalBroadcastAuth rejects this caller with 401 — the combination is
    // a misconfiguration, and the helper must not paper over it.
    expect(internalBroadcastHeaders(null)).toEqual({
      "Content-Type": "application/json",
    });
  });
});
