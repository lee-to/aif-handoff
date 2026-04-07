import { describe, it, expect } from "vitest";
import { createStderrCollector } from "../stderrCollector.js";

describe("stderrCollector", () => {
  it("collects stderr tail lines", () => {
    const collector = createStderrCollector(2);
    collector.onStderr("line1\nline2\n");
    collector.onStderr("line3\n");

    expect(collector.getTail()).toBe("line2 | line3");
  });

  it("returns empty string when no stderr collected", () => {
    const collector = createStderrCollector();
    expect(collector.getTail()).toBe("");
  });

  it("trims whitespace lines", () => {
    const collector = createStderrCollector();
    collector.onStderr("  \nfoo\n  \nbar\n");
    expect(collector.getTail()).toBe("foo | bar");
  });
});
