import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aif/shared", () => ({
  logger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  getCached,
  setCached,
  invalidateCache,
  invalidateAllSessionCaches,
  sessionCacheKey,
} from "../services/sessionCache.js";

beforeEach(() => {
  vi.useFakeTimers();
  invalidateAllSessionCaches();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionCache", () => {
  it("returns undefined for missing keys", () => {
    expect(getCached("missing")).toBeUndefined();
  });

  it("stores and retrieves cached data", () => {
    setCached("key1", [1, 2, 3]);
    expect(getCached<number[]>("key1")).toEqual([1, 2, 3]);
  });

  it("expires entries after TTL", () => {
    setCached("key2", "value", 5000);
    expect(getCached("key2")).toBe("value");

    vi.advanceTimersByTime(5001);
    expect(getCached("key2")).toBeUndefined();
  });

  it("uses default TTL of 10s", () => {
    setCached("key3", "value");

    vi.advanceTimersByTime(9999);
    expect(getCached("key3")).toBe("value");

    vi.advanceTimersByTime(2);
    expect(getCached("key3")).toBeUndefined();
  });

  it("invalidates specific key", () => {
    setCached("a", 1);
    setCached("b", 2);
    invalidateCache("a");
    expect(getCached("a")).toBeUndefined();
    expect(getCached("b")).toBe(2);
  });

  it("invalidates all caches", () => {
    setCached("a", 1);
    setCached("b", 2);
    invalidateAllSessionCaches();
    expect(getCached("a")).toBeUndefined();
    expect(getCached("b")).toBeUndefined();
  });

  it("generates consistent cache keys", () => {
    expect(sessionCacheKey("claude", null, "/home/user/project")).toBe(
      "runtime-sessions:claude:default:/home/user/project",
    );
  });
});
