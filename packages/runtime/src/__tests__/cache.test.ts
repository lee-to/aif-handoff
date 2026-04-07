import { describe, expect, it } from "vitest";
import { createRuntimeMemoryCache } from "../cache.js";

describe("RuntimeMemoryCache", () => {
  it("stores and retrieves a value", () => {
    const cache = createRuntimeMemoryCache<string>();
    cache.set("a", "hello");
    expect(cache.get("a")).toBe("hello");
  });

  it("returns null for missing keys", () => {
    const cache = createRuntimeMemoryCache<string>();
    expect(cache.get("missing")).toBeNull();
  });

  it("deletes a key", () => {
    const cache = createRuntimeMemoryCache<string>();
    cache.set("a", "value");
    cache.delete("a");
    expect(cache.get("a")).toBeNull();
  });

  it("clears all entries", () => {
    const cache = createRuntimeMemoryCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  it("expires entries after TTL", () => {
    let time = 1000;
    const cache = createRuntimeMemoryCache<string>({
      defaultTtlMs: 100,
      now: () => time,
    });

    cache.set("a", "value");
    expect(cache.get("a")).toBe("value");

    time = 1101; // past TTL
    expect(cache.get("a")).toBeNull();
  });

  it("respects per-key TTL override", () => {
    let time = 1000;
    const cache = createRuntimeMemoryCache<string>({
      defaultTtlMs: 500,
      now: () => time,
    });

    cache.set("short", "val", 50);
    cache.set("long", "val", 1000);

    time = 1060;
    expect(cache.get("short")).toBeNull();
    expect(cache.get("long")).toBe("val");
  });

  it("evicts oldest when max size reached", () => {
    const cache = createRuntimeMemoryCache<string>({
      maxSize: 2,
      defaultTtlMs: 60_000,
    });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3"); // should evict "a"

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("evicts expired entries before falling back to oldest", () => {
    let time = 1000;
    const cache = createRuntimeMemoryCache<string>({
      maxSize: 2,
      defaultTtlMs: 100,
      now: () => time,
    });

    cache.set("expired", "val");
    time = 1200; // expired
    cache.set("fresh", "val");
    cache.set("newest", "val"); // eviction triggered, should evict "expired" first

    expect(cache.get("expired")).toBeNull();
    expect(cache.get("fresh")).toBe("val");
    expect(cache.get("newest")).toBe("val");
  });

  it("overwrites existing key", () => {
    const cache = createRuntimeMemoryCache<string>();
    cache.set("a", "old");
    cache.set("a", "new");
    expect(cache.get("a")).toBe("new");
  });

  it("treats TTL of 0 or negative as minimum 1ms", () => {
    let time = 1000;
    const cache = createRuntimeMemoryCache<string>({ now: () => time });

    cache.set("a", "val", 0);
    expect(cache.get("a")).toBe("val");

    time = 1002;
    expect(cache.get("a")).toBeNull();
  });
});
