import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useActivityLogParsing, parseEntry } from "@/hooks/useActivityLogParsing";

describe("parseEntry", () => {
  it("parses tool entries", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] Tool: Read");
    expect(entry.kind).toBe("tool");
    expect(entry.toolName).toBe("Read");
    expect(entry.timestamp).toBe("2026-01-01T10:00:00.000Z");
  });

  it("parses error entries", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] Planning failed: rate limit");
    expect(entry.kind).toBe("error");
    expect(entry.timestamp).toBe("2026-01-01T10:00:00.000Z");
    expect(entry.message).toBe("Planning failed: rate limit");
  });

  it("parses agent entries", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] Agent started planning");
    expect(entry.kind).toBe("agent");
  });

  it("parses subagent entries", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] Subagent completed review");
    expect(entry.kind).toBe("agent");
  });

  it("parses info entries", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] Implementation complete");
    expect(entry.kind).toBe("info");
  });

  it("handles entries without timestamps", () => {
    const entry = parseEntry("Some log message");
    expect(entry.timestamp).toBeNull();
    expect(entry.kind).toBe("info");
    expect(entry.message).toBe("Some log message");
  });

  it("handles tool entries case-insensitively", () => {
    const entry = parseEntry("[2026-01-01T10:00:00.000Z] tool: Write");
    expect(entry.kind).toBe("tool");
    expect(entry.toolName).toBe("Write");
  });

  it("extracts runtime metadata including effort", () => {
    const entry = parseEntry(
      "[2026-01-01T10:00:00.000Z] Agent: planner started (runtime=codex, transport=sdk, model=gpt-5, effort=high)",
    );
    expect(entry.kind).toBe("agent");
    expect(entry.runtimeMeta).toEqual({
      runtimeId: "codex",
      transport: "sdk",
      profileId: undefined,
      model: "gpt-5",
      effort: "high",
    });
    expect(entry.message).toBe("Agent: planner started");
  });

  it("leaves effort undefined when omitted from runtime metadata", () => {
    const entry = parseEntry(
      "[2026-01-01T10:00:00.000Z] Agent: planner started (runtime=claude, transport=sdk, model=default)",
    );
    expect(entry.runtimeMeta?.effort).toBeUndefined();
  });
});

describe("useActivityLogParsing", () => {
  const sampleLog = [
    "[2026-01-01T10:00:00.000Z] Tool: Read",
    "[2026-01-01T10:00:01.000Z] Agent started planning",
    "[2026-01-01T10:00:02.000Z] Planning failed: rate limit",
    "[2026-01-01T10:00:03.000Z] Implementation complete",
  ].join("\n");

  it("returns empty arrays for null log", () => {
    const { result } = renderHook(() => useActivityLogParsing(null));
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.parsedEntries).toHaveLength(0);
    expect(result.current.visibleEntries).toHaveLength(0);
  });

  it("parses all entries", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    expect(result.current.parsedEntries).toHaveLength(4);
    expect(result.current.filter).toBe("all");
    expect(result.current.visibleEntries).toHaveLength(4);
  });

  it("filters by tool", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    act(() => result.current.setFilter("tool"));
    expect(result.current.visibleEntries).toHaveLength(1);
    expect(result.current.visibleEntries[0].kind).toBe("tool");
  });

  it("filters by agent", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    act(() => result.current.setFilter("agent"));
    expect(result.current.visibleEntries).toHaveLength(1);
    expect(result.current.visibleEntries[0].kind).toBe("agent");
  });

  it("filters by error", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    act(() => result.current.setFilter("error"));
    expect(result.current.visibleEntries).toHaveLength(1);
    expect(result.current.visibleEntries[0].kind).toBe("error");
  });

  it("computes stats correctly", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    expect(result.current.stats.total).toBe(4);
    expect(result.current.stats.byKind.tool).toBe(1);
    expect(result.current.stats.byKind.agent).toBe(1);
    expect(result.current.stats.byKind.error).toBe(1);
    expect(result.current.stats.byKind.info).toBe(1);
  });

  it("resets to all filter", () => {
    const { result } = renderHook(() => useActivityLogParsing(sampleLog));
    act(() => result.current.setFilter("tool"));
    expect(result.current.visibleEntries).toHaveLength(1);
    act(() => result.current.setFilter("all"));
    expect(result.current.visibleEntries).toHaveLength(4);
  });

  it("skips empty lines", () => {
    const logWithBlanks = "line one\n\n\nline two\n";
    const { result } = renderHook(() => useActivityLogParsing(logWithBlanks));
    expect(result.current.entries).toHaveLength(2);
  });
});
