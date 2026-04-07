import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db.js";
import { tasks } from "../schema.js";
import type { TaskStatus } from "../types.js";

describe("tasks schema", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("should insert and query a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks)
      .values({
        id,
        projectId: "test-project",
        title: "Test task",
        description: "A test description",
        status: "backlog",
        priority: 1,
        position: 1000.0,
      })
      .run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result).toBeDefined();
    expect(result!.title).toBe("Test task");
    expect(result!.description).toBe("A test description");
    expect(result!.status).toBe("backlog");
    expect(result!.priority).toBe(1);
    expect(result!.position).toBe(1000.0);
  });

  it("should update a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "Original" }).run();

    db.update(tasks).set({ title: "Updated", status: "planning" }).where(eq(tasks.id, id)).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.title).toBe("Updated");
    expect(result!.status).toBe("planning");
  });

  it("should delete a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "To delete" }).run();

    db.delete(tasks).where(eq(tasks.id, id)).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result).toBeUndefined();
  });

  it("should order tasks by position", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    db.insert(tasks)
      .values({ id: ids[0], projectId: "test-project", title: "Third", position: 3000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[1], projectId: "test-project", title: "First", position: 1000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[2], projectId: "test-project", title: "Second", position: 2000.0 })
      .run();

    const results = db.select().from(tasks).orderBy(tasks.position).all();

    expect(results[0].title).toBe("First");
    expect(results[1].title).toBe("Second");
    expect(results[2].title).toBe("Third");
  });

  it("should support fractional position indexing", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    db.insert(tasks)
      .values({ id: ids[0], projectId: "test-project", title: "A", position: 1000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[1], projectId: "test-project", title: "C", position: 2000.0 })
      .run();
    // Insert between A and C
    db.insert(tasks)
      .values({ id: ids[2], projectId: "test-project", title: "B", position: 1500.0 })
      .run();

    const results = db.select().from(tasks).orderBy(tasks.position).all();

    expect(results.map((r) => r.title)).toEqual(["A", "B", "C"]);
  });

  it("should store all task statuses", () => {
    const statuses: TaskStatus[] = [
      "backlog",
      "planning",
      "plan_ready",
      "implementing",
      "review",
      "blocked_external",
      "done",
      "verified",
    ];

    for (const status of statuses) {
      const id = crypto.randomUUID();
      db.insert(tasks)
        .values({ id, projectId: "test-project", title: `Task ${status}`, status })
        .run();
      const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
      expect(result!.status).toBe(status);
    }
  });

  it("should store nullable fields", () => {
    const id = crypto.randomUUID();
    db.insert(tasks)
      .values({
        id,
        projectId: "test-project",
        title: "Task with plan",
        plan: "## My Plan\n- Step 1",
        implementationLog: "Implemented X",
        reviewComments: "Looks good",
        agentActivityLog: "[2026-01-01] Tool: Read",
      })
      .run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.plan).toBe("## My Plan\n- Step 1");
    expect(result!.implementationLog).toBe("Implemented X");
    expect(result!.reviewComments).toBe("Looks good");
    expect(result!.agentActivityLog).toBe("[2026-01-01] Tool: Read");
  });

  it("should have default values for new tasks", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "Defaults" }).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.status).toBe("backlog");
    expect(result!.priority).toBe(0);
    expect(result!.position).toBe(1000.0);
    expect(result!.description).toBe("");
    expect(result!.autoMode).toBe(true);
    expect(result!.plan).toBeNull();
    expect(result!.implementationLog).toBeNull();
    expect(result!.reviewComments).toBeNull();
    expect(result!.agentActivityLog).toBeNull();
    expect(result!.blockedReason).toBeNull();
    expect(result!.blockedFromStatus).toBeNull();
    expect(result!.retryAfter).toBeNull();
    expect(result!.retryCount).toBe(0);
    expect(result!.tokenInput).toBe(0);
    expect(result!.tokenOutput).toBe(0);
    expect(result!.tokenTotal).toBe(0);
    expect(result!.costUsd).toBe(0);
  });
});
