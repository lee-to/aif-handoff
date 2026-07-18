import { describe, it, expect } from "vitest";
import type { TaskListItem } from "@aif/shared/browser";

/**
 * Parity guard for the TaskListItem projection.
 *
 * TaskListItem is a lightweight projection of Task that powers the board/list
 * rendering (Board, TaskCard, TaskListTable). If a field that those components
 * consume is later dropped from TaskListItem, the board silently breaks at
 * runtime even though TypeScript stays quiet (the consumer reads `undefined`).
 *
 * This test pins the set of fields the board needs and asserts they are all
 * present on TaskListItem. Adding a board-consumed field without extending
 * TaskListItem fails this test explicitly.
 */

// The fields the board/card/list-table read off a task on `main`. Sourced from
// TaskCard.tsx + Board.tsx + TaskListTable.tsx usage. Keep in sync when the
// board starts consuming a new field.
const BOARD_CONSUMED_FIELDS = [
  "id",
  "projectId",
  "title",
  "description",
  "status",
  "priority",
  "position",
  "tags",
  "autoMode",
  "isFix",
  "paused",
  "blockedReason",
  "blockedFromStatus",
  "manualReviewRequired",
  "reworkRequested",
  "reviewIterationCount",
  "maxReviewIterations",
  "retryCount",
  "retryAfter",
  "scheduledAt",
  "roadmapAlias",
  "hasPlan",
  // Runtime-budget plaque for blocked_external (feature-gated by usageLimits).
  "runtimeLimitSnapshot",
  "runtimeLimitUpdatedAt",
  "updatedAt",
  "createdAt",
] as const;

describe("TaskListItem parity with board consumers", () => {
  it("every field the board consumes is present on TaskListItem", () => {
    // Fixture with all fields set so keys() is exhaustive.
    const fixture: TaskListItem = {
      id: "t1",
      projectId: "p1",
      title: "T",
      description: "D",
      autoMode: false,
      isFix: false,
      status: "backlog",
      priority: 0,
      position: 0,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: 0,
      roadmapAlias: null,
      tags: [],
      reworkRequested: false,
      reviewIterationCount: 0,
      maxReviewIterations: 0,
      manualReviewRequired: false,
      paused: false,
      lastSyncedAt: null,
      runtimeLimitSnapshot: null,
      runtimeLimitUpdatedAt: null,
      scheduledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hasPlan: false,
    };

    const itemKeys = new Set(Object.keys(fixture));
    const missing = BOARD_CONSUMED_FIELDS.filter((f) => !itemKeys.has(f));

    expect(missing, `TaskListItem dropped board-consumed fields: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});
