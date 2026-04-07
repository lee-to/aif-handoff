import { describe, it, expect } from "vitest";
import { parsePlanAnnotations, insertPlanAnnotation } from "../sync.js";
import type { SyncDirection, ConflictResolution, SyncEvent, PlanAnnotation } from "../sync.js";

// ── Test Helpers ────────────────────────────────────────────

const UUID_A = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const UUID_B = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const UUID_C = "c3d4e5f6-a7b8-9012-cdef-123456789012";

function annotation(taskId: string): string {
  return `<!-- handoff:task:${taskId} -->`;
}

// ── parsePlanAnnotations ────────────────────────────────────

describe("parsePlanAnnotations", () => {
  it("returns empty array for markdown with no annotations", () => {
    const md = "# Hello\n\nSome content here.\n\n- bullet point\n";
    expect(parsePlanAnnotations(md)).toEqual([]);
  });

  it("returns empty array for empty string input", () => {
    expect(parsePlanAnnotations("")).toEqual([]);
  });

  it("finds a single annotation and returns correct taskId and line number", () => {
    const md = `# Plan\n\n${annotation(UUID_A)}\n\nSome content`;
    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ taskId: UUID_A, line: 3 });
  });

  it("finds multiple annotations across different lines", () => {
    const md = [
      "# Plan",
      annotation(UUID_A),
      "## Section 1",
      "Some text",
      annotation(UUID_B),
      "## Section 2",
      annotation(UUID_C),
    ].join("\n");

    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ taskId: UUID_A, line: 2 });
    expect(result[1]).toEqual({ taskId: UUID_B, line: 5 });
    expect(result[2]).toEqual({ taskId: UUID_C, line: 7 });
  });

  it("handles multiple annotations on the same line", () => {
    const md = `# Plan\n${annotation(UUID_A)} ${annotation(UUID_B)}`;
    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ taskId: UUID_A, line: 2 });
    expect(result[1]).toEqual({ taskId: UUID_B, line: 2 });
  });

  it("ignores malformed annotations with invalid UUID format", () => {
    const malformed = [
      "<!-- handoff:task:not-a-uuid -->",
      "<!-- handoff:task:12345 -->",
      "<!-- handoff:task: -->",
      "<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd -->", // too short
      "<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890-extra -->", // extra segment
      "<!-- handoff:wrong:a1b2c3d4-e5f6-7890-abcd-ef1234567890 -->", // wrong prefix
    ].join("\n");
    expect(parsePlanAnnotations(malformed)).toEqual([]);
  });

  it("returns annotations sorted by line number", () => {
    const md = [annotation(UUID_C), "text", annotation(UUID_A), "text", annotation(UUID_B)].join(
      "\n",
    );

    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(3);
    // Verify sorted by line
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(3);
    expect(result[2].line).toBe(5);
    // Verify taskIds are in order of appearance (by line)
    expect(result[0].taskId).toBe(UUID_C);
    expect(result[1].taskId).toBe(UUID_A);
    expect(result[2].taskId).toBe(UUID_B);
  });

  it("handles case-insensitive UUID matching", () => {
    const upperUuid = UUID_A.toUpperCase();
    const md = `<!-- handoff:task:${upperUuid} -->`;
    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(1);
    // The regex captures the UUID as-is (uppercase), since [0-9a-f] with 'i' flag
    expect(result[0].taskId.toLowerCase()).toBe(UUID_A.toLowerCase());
  });

  it("handles annotations with varying whitespace inside the comment", () => {
    const md = `<!--   handoff:task:${UUID_A}   -->`;
    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe(UUID_A);
  });

  it("parses annotation embedded within other content on a line", () => {
    const md = `Some text ${annotation(UUID_A)} more text`;
    const result = parsePlanAnnotations(md);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe(UUID_A);
  });
});

// ── insertPlanAnnotation ────────────────────────────────────

describe("insertPlanAnnotation", () => {
  it("inserts annotation at top when no section heading specified", () => {
    const md = "# Plan\n\nSome content";
    const result = insertPlanAnnotation(md, UUID_A);
    const lines = result.split("\n");
    expect(lines[0]).toBe(annotation(UUID_A));
    expect(lines[1]).toBe("# Plan");
  });

  it("inserts annotation after specified section heading", () => {
    const md = "# Plan\n\n## Overview\n\nContent here";
    const result = insertPlanAnnotation(md, UUID_A, "Overview");
    const lines = result.split("\n");
    const overviewIdx = lines.indexOf("## Overview");
    expect(overviewIdx).toBeGreaterThan(-1);
    expect(lines[overviewIdx + 1]).toBe(annotation(UUID_A));
  });

  it("handles heading with different levels (# vs ## vs ###)", () => {
    const md = "# Top Level\n\n## Second Level\n\n### Third Level\n\nContent";

    const r1 = insertPlanAnnotation(md, UUID_A, "Top Level");
    expect(r1.split("\n")[1]).toBe(annotation(UUID_A));

    const r2 = insertPlanAnnotation(md, UUID_A, "Second Level");
    const lines2 = r2.split("\n");
    const idx2 = lines2.indexOf("## Second Level");
    expect(lines2[idx2 + 1]).toBe(annotation(UUID_A));

    const r3 = insertPlanAnnotation(md, UUID_A, "Third Level");
    const lines3 = r3.split("\n");
    const idx3 = lines3.indexOf("### Third Level");
    expect(lines3[idx3 + 1]).toBe(annotation(UUID_A));
  });

  it("falls back to top insertion when heading is not found", () => {
    const md = "# Plan\n\n## Tasks\n\nContent";
    const result = insertPlanAnnotation(md, UUID_A, "NonExistent");
    const lines = result.split("\n");
    expect(lines[0]).toBe(annotation(UUID_A));
  });

  it("replaces existing annotation for the same taskId (deduplication)", () => {
    const md = `# Plan\n${annotation(UUID_A)}\n\n## Tasks\n\nContent`;
    const result = insertPlanAnnotation(md, UUID_A, "Tasks");
    const annotations = parsePlanAnnotations(result);
    const matching = annotations.filter((a) => a.taskId === UUID_A);
    expect(matching).toHaveLength(1);
    // It should now be after the Tasks heading, not at line 2
    const lines = result.split("\n");
    const tasksIdx = lines.indexOf("## Tasks");
    expect(lines[tasksIdx + 1]).toBe(annotation(UUID_A));
  });

  it("result has only one annotation for the taskId after deduplication", () => {
    // Put the same annotation in twice manually
    const md = `${annotation(UUID_A)}\n# Plan\n${annotation(UUID_A)}\nContent`;
    const result = insertPlanAnnotation(md, UUID_A);
    const annotations = parsePlanAnnotations(result);
    const matching = annotations.filter((a) => a.taskId === UUID_A);
    expect(matching).toHaveLength(1);
  });

  it("preserves existing content and other annotations", () => {
    const md = [
      "# Plan",
      annotation(UUID_B),
      "## Overview",
      "Some content here",
      "## Tasks",
      annotation(UUID_C),
      "- Task list",
    ].join("\n");

    const result = insertPlanAnnotation(md, UUID_A, "Overview");
    // UUID_B and UUID_C should still be present
    const annotations = parsePlanAnnotations(result);
    const taskIds = annotations.map((a) => a.taskId);
    expect(taskIds).toContain(UUID_A);
    expect(taskIds).toContain(UUID_B);
    expect(taskIds).toContain(UUID_C);
    // Original content should be preserved
    expect(result).toContain("Some content here");
    expect(result).toContain("- Task list");
  });

  it("works with empty markdown", () => {
    const result = insertPlanAnnotation("", UUID_A);
    expect(result).toContain(annotation(UUID_A));
    const annotations = parsePlanAnnotations(result);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].taskId).toBe(UUID_A);
  });

  it("works with empty markdown and a section heading (falls back to top)", () => {
    const result = insertPlanAnnotation("", UUID_A, "Overview");
    expect(result).toContain(annotation(UUID_A));
    const annotations = parsePlanAnnotations(result);
    expect(annotations).toHaveLength(1);
  });
});

// ── Type Validation ─────────────────────────────────────────

describe("type validation", () => {
  it("SyncDirection is a union of 'aif_to_handoff' | 'handoff_to_aif'", () => {
    // Compile-time type assertions: if these assignments compile, the type is correct
    const d1: SyncDirection = "aif_to_handoff";
    const d2: SyncDirection = "handoff_to_aif";
    expect(d1).toBe("aif_to_handoff");
    expect(d2).toBe("handoff_to_aif");

    // @ts-expect-error -- invalid direction should not compile
    const _invalid: SyncDirection = "invalid_direction";
  });

  it("ConflictResolution interface has correct shape", () => {
    const cr: ConflictResolution = {
      applied: true,
      conflict: false,
      winner: "source",
      sourceTimestamp: "2026-03-31T12:00:00.000Z",
      targetTimestamp: "2026-03-31T12:00:01.000Z",
      field: "status",
    };
    expect(cr.applied).toBe(true);
    expect(cr.conflict).toBe(false);
    expect(cr.winner).toBe("source");
    expect(cr.sourceTimestamp).toBe("2026-03-31T12:00:00.000Z");
    expect(cr.targetTimestamp).toBe("2026-03-31T12:00:01.000Z");
    expect(cr.field).toBe("status");

    // winner can also be "target" or null
    const cr2: ConflictResolution = { ...cr, winner: "target" };
    expect(cr2.winner).toBe("target");
    const cr3: ConflictResolution = { ...cr, winner: null };
    expect(cr3.winner).toBeNull();
  });

  it("SyncEvent interface has correct shape", () => {
    const event: SyncEvent = {
      type: "sync:task_created",
      taskId: UUID_A,
      direction: "aif_to_handoff",
      timestamp: "2026-03-31T12:00:00.000Z",
    };
    expect(event.type).toBe("sync:task_created");
    expect(event.taskId).toBe(UUID_A);
    expect(event.direction).toBe("aif_to_handoff");
    expect(event.timestamp).toBe("2026-03-31T12:00:00.000Z");

    // With optional fields
    const eventWithChanges: SyncEvent = {
      ...event,
      type: "sync:task_updated",
      changes: { status: { from: "backlog", to: "planning" } },
      conflictResolution: {
        applied: true,
        conflict: true,
        winner: "source",
        sourceTimestamp: "2026-03-31T12:00:00.000Z",
        targetTimestamp: "2026-03-31T11:59:59.000Z",
        field: "status",
      },
    };
    expect(eventWithChanges.changes).toBeDefined();
    expect(eventWithChanges.conflictResolution?.conflict).toBe(true);
  });

  it("PlanAnnotation interface has taskId and line fields", () => {
    const pa: PlanAnnotation = { taskId: UUID_A, line: 5 };
    expect(pa.taskId).toBe(UUID_A);
    expect(pa.line).toBe(5);
  });

  it("SyncEvent type covers all event types", () => {
    const types: SyncEvent["type"][] = [
      "sync:task_created",
      "sync:task_updated",
      "sync:status_changed",
      "sync:plan_pushed",
    ];
    expect(types).toHaveLength(4);
    // Each should be a valid SyncEvent type
    for (const t of types) {
      const event: SyncEvent = {
        type: t,
        taskId: UUID_A,
        direction: "handoff_to_aif",
        timestamp: new Date().toISOString(),
      };
      expect(event.type).toBe(t);
    }
  });
});
