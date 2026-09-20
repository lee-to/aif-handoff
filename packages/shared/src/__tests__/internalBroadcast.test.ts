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

  it.each(["development", "production", ""])(
    "sends no auth hint without a token (NODE_ENV=%j)",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);

      // internalBroadcastAuth only ever accepts a matching token, or any caller
      // while NODE_ENV=test. There is no loopback-header fallback to reach for,
      // so a missing token is a misconfiguration the helper must not paper over.
      expect(internalBroadcastHeaders(undefined)).toEqual({
        "Content-Type": "application/json",
      });
      expect(internalBroadcastHeaders(null)).toEqual({
        "Content-Type": "application/json",
      });
    },
  );
});
