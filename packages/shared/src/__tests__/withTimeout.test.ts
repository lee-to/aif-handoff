import { describe, it, expect } from "vitest";
import { withTimeout } from "../withTimeout.js";

describe("withTimeout", () => {
  it("resolves when the promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "timeout");
    expect(result).toBe("ok");
  });

  it("rejects with the timeout message when the promise is too slow", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    await expect(withTimeout(slow, 10, "too slow")).rejects.toThrow("too slow");
  });

  it("propagates the original rejection if it happens before timeout", async () => {
    const failing = Promise.reject(new Error("original"));
    await expect(withTimeout(failing, 1000, "timeout")).rejects.toThrow("original");
  });
});
