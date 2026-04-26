import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  codexLimitHeads,
  codexLimitHistory,
  codexSessionFiles,
  codexSessions,
  projects,
  tasks,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  createTask,
  updateTask,
  setTaskFields,
  deleteTask,
  findTaskById,
  listTasks,
  toTaskResponse,
  toCommentResponse,
  listTaskComments,
  createTaskComment,
  updateTaskComment,
  getLatestHumanComment,
  getLatestReworkComment,
  listProjects,
  findProjectById,
  createProject,
  updateProject,
  deleteProject,
  findProjectByTaskId,
  appendTaskActivityLog,
  updateTaskHeartbeat,
  updateTaskStatus,
  incrementTaskTokenUsage,
  findTasksByRoadmapAlias,
  persistTaskPlanForTask,
  findCoordinatorTaskCandidate,
  findCoordinatorTaskCandidates,
  claimTask,
  releaseTaskClaim,
  releaseStaleTaskClaims,
  hasActiveLockedTaskForProject,
  renewTaskClaim,
  searchTasks,
  touchLastSyncedAt,
  listTasksPaginated,
  searchTasksPaginated,
  toTaskSummary,
  listDueScheduledTasks,
  clearScheduledAt,
  updateScheduledAt,
  getAutoQueueMode,
  setAutoQueueMode,
  nextBacklogTaskByPosition,
  listAutoQueueProjects,
  countActivePipelineTasksForProject,
  claimBacklogTaskForAdvance,
  createChatSession,
  upsertCodexSessions,
  upsertCodexSessionFiles,
  upsertCodexLimitHeads,
  appendCodexLimitHistory,
  pruneCodexLimitHistoryByHead,
  pruneCodexLimitHistoryRetention,
  pruneCodexLimitRowsBeforeObservedAt,
  pruneStaleCodexSessionIndexRows,
  deleteCodexLimitHeadsByFilePaths,
  deleteCodexLimitHistoryByFilePaths,
  listCodexLimitHeadScopesByFilePaths,
  upsertCodexIndexCursor,
  findCodexIndexCursor,
  listCodexSessionFileStates,
  listCodexSessionFileStatesByPaths,
  deleteCodexSessionsByFilePaths,
} = await import("../index.js");

function seedProject(id = "proj-1") {
  testDb.current
    .insert(projects)
    .values({ id, name: "Test", rootPath: "/tmp/test" })
    .run();
}

function makeCodexSnapshot(checkedAt = "2026-04-23T10:00:00.000Z") {
  return {
    source: "sdk_event" as const,
    status: "warning" as const,
    precision: "heuristic" as const,
    checkedAt,
    providerId: "openai",
    runtimeId: "codex",
    profileId: "profile-codex",
    primaryScope: "time" as const,
    windows: [
      {
        scope: "time" as const,
        percentUsed: 61,
        percentRemaining: 39,
      },
    ],
  };
}

describe("data layer", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
  });

  // ── Tasks CRUD ──────────────────────────────────────────

  describe("createTask", () => {
    it("creates a task with defaults", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(t).toBeDefined();
      expect(t!.title).toBe("T");
      expect(t!.status).toBe("backlog");
    });

    it("creates a task with all optional fields", () => {
      const t = createTask({
        projectId: "proj-1",
        title: "Full",
        description: "D",
        attachments: [{ type: "file", url: "a.txt" }],
        priority: 2,
        autoMode: true,
        isFix: true,
        plannerMode: "fast",
        planPath: "/plan.md",
        planDocs: true,
        planTests: true,
        skipReview: true,
        useSubagents: true,
        maxReviewIterations: 5,
        paused: true,
        roadmapAlias: "alias-1",
        tags: ["tag1", "tag2"],
      });
      expect(t).toBeDefined();
      expect(t!.priority).toBe(2);
      expect(t!.autoMode).toBe(true);
      expect(t!.isFix).toBe(true);
      expect(t!.roadmapAlias).toBe("alias-1");
    });
  });

  describe("listTasks", () => {
    it("lists all tasks", () => {
      createTask({ projectId: "proj-1", title: "A", description: "D" });
      createTask({ projectId: "proj-1", title: "B", description: "D" });
      expect(listTasks()).toHaveLength(2);
    });

    it("filters by projectId", () => {
      seedProject("proj-2");
      createTask({ projectId: "proj-1", title: "A", description: "D" });
      createTask({ projectId: "proj-2", title: "B", description: "D" });
      expect(listTasks("proj-1")).toHaveLength(1);
      expect(listTasks("proj-2")).toHaveLength(1);
    });
  });

  describe("updateTask", () => {
    it("updates basic fields", () => {
      const t = createTask({ projectId: "proj-1", title: "Old", description: "D" });
      const updated = updateTask(t!.id, { title: "New" });
      expect(updated!.title).toBe("New");
    });

    it("serializes attachments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const updated = updateTask(t!.id, { attachments: [{ type: "image", url: "img.png" }] });
      expect(updated).toBeDefined();
      const resp = toTaskResponse(updated!);
      expect(resp.attachments).toHaveLength(1);
    });

    it("serializes tags", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const updated = updateTask(t!.id, { tags: ["a", "b"] });
      expect(updated).toBeDefined();
      const resp = toTaskResponse(updated!);
      expect(resp.tags).toEqual(["a", "b"]);
    });
  });

  describe("setTaskFields", () => {
    it("sets raw fields on task", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      setTaskFields(t!.id, { implementationLog: "log data" });
      const found = findTaskById(t!.id);
      expect(found!.implementationLog).toBe("log data");
    });
  });

  describe("deleteTask", () => {
    it("deletes task and its comments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      createTaskComment({ taskId: t!.id, author: "human", message: "hi" });
      deleteTask(t!.id);
      expect(findTaskById(t!.id)).toBeUndefined();
      expect(listTaskComments(t!.id)).toHaveLength(0);
    });
  });

  // ── toTaskResponse / parseTags edge cases ───────────────

  describe("toTaskResponse", () => {
    it("handles empty tags", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const resp = toTaskResponse(t!);
      expect(resp.tags).toEqual([]);
    });

    it("handles malformed tags JSON", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      setTaskFields(t!.id, { tags: "not-json" });
      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);
      expect(resp.tags).toEqual([]);
    });

    it("filters non-string values from tags", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      setTaskFields(t!.id, { tags: JSON.stringify(["ok", 123, null]) });
      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);
      expect(resp.tags).toEqual(["ok"]);
    });

    it("parses persisted autoReviewState JSON from task rows", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      setTaskFields(t!.id, {
        manualReviewRequired: true,
        autoReviewState: {
          strategy: "closure_first",
          iteration: 2,
          findings: [
            {
              id: "finding-1",
              source: "code_review",
              text: "Add manual review banner",
            },
          ],
        },
      });
      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);
      expect(resp.manualReviewRequired).toBe(true);
      expect(resp.autoReviewState).toEqual({
        strategy: "closure_first",
        iteration: 2,
        findings: [
          {
            id: "finding-1",
            source: "code_review",
            text: "Add manual review banner",
          },
        ],
      });
    });

    it("returns null for malformed autoReviewState JSON", () => {
      const t = createTask({ projectId: "proj-1", title: "Malformed", description: "D" });
      setTaskFields(t!.id, { autoReviewStateJson: "{not-valid-json" });

      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);

      expect(resp.autoReviewState).toBeNull();
    });

    it("returns null for autoReviewState with unsupported strategy", () => {
      const t = createTask({ projectId: "proj-1", title: "Bad Strategy", description: "D" });
      setTaskFields(t!.id, {
        autoReviewStateJson: JSON.stringify({
          strategy: "unknown_strategy",
          iteration: 1,
          findings: [],
        }),
      });

      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);

      expect(resp.autoReviewState).toBeNull();
    });

    it("returns null for autoReviewState with unsupported finding source", () => {
      const t = createTask({ projectId: "proj-1", title: "Bad Finding", description: "D" });
      setTaskFields(t!.id, {
        autoReviewStateJson: JSON.stringify({
          strategy: "closure_first",
          iteration: 1,
          findings: [
            {
              id: "finding-1",
              source: "unknown_source",
              text: "Bad finding source",
            },
          ],
        }),
      });

      const raw = findTaskById(t!.id)!;
      const resp = toTaskResponse(raw);

      expect(resp.autoReviewState).toBeNull();
    });
  });

  // ── Comments ────────────────────────────────────────────

  describe("comments", () => {
    it("creates and lists comments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      createTaskComment({ taskId: t!.id, author: "human", message: "hello" });
      createTaskComment({ taskId: t!.id, author: "agent", message: "reply" });
      const comments = listTaskComments(t!.id);
      expect(comments).toHaveLength(2);
    });

    it("creates comment with custom createdAt", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const c = createTaskComment({
        taskId: t!.id,
        author: "human",
        message: "msg",
        createdAt: "2025-01-01T00:00:00Z",
      });
      expect(c!.createdAt).toBe("2025-01-01T00:00:00Z");
    });

    it("creates comment with attachments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const c = createTaskComment({
        taskId: t!.id,
        author: "human",
        message: "msg",
        attachments: [{ type: "file", url: "f.txt" }],
      });
      const resp = toCommentResponse(c!);
      expect(resp.attachments).toHaveLength(1);
    });

    it("updateTaskComment updates attachments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const c = createTaskComment({ taskId: t!.id, author: "human", message: "msg" });
      const updated = updateTaskComment(c!.id, {
        attachments: [{ type: "image", url: "img.png" }],
      });
      const resp = toCommentResponse(updated!);
      expect(resp.attachments).toHaveLength(1);
    });

    it("updateTaskComment with no changes returns existing", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const c = createTaskComment({ taskId: t!.id, author: "human", message: "msg" });
      const same = updateTaskComment(c!.id, {});
      expect(same!.id).toBe(c!.id);
    });

    it("getLatestHumanComment returns last human comment", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      createTaskComment({ taskId: t!.id, author: "agent", message: "a", createdAt: "2025-01-01T00:00:00Z" });
      createTaskComment({ taskId: t!.id, author: "human", message: "h1", createdAt: "2025-01-01T00:01:00Z" });
      createTaskComment({ taskId: t!.id, author: "human", message: "h2", createdAt: "2025-01-01T00:02:00Z" });
      expect(getLatestHumanComment(t!.id)!.message).toBe("h2");
    });

    it("getLatestHumanComment returns undefined when no human comments", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      createTaskComment({ taskId: t!.id, author: "agent", message: "a" });
      expect(getLatestHumanComment(t!.id)).toBeUndefined();
    });

    it("getLatestReworkComment returns last comment", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      createTaskComment({ taskId: t!.id, author: "agent", message: "a", createdAt: "2025-01-01T00:00:00Z" });
      createTaskComment({ taskId: t!.id, author: "human", message: "h", createdAt: "2025-01-01T00:01:00Z" });
      expect(getLatestReworkComment(t!.id)!.message).toBe("h");
    });
  });

  // ── Projects CRUD ───────────────────────────────────────

  describe("projects", () => {
    it("listProjects returns all projects", () => {
      expect(listProjects()).toHaveLength(1);
    });

    it("findProjectById returns project", () => {
      expect(findProjectById("proj-1")).toBeDefined();
    });

    it("findProjectById returns undefined for missing", () => {
      expect(findProjectById("missing")).toBeUndefined();
    });

    it("createProject creates with budget fields", () => {
      const p = createProject({
        name: "P2",
        rootPath: "/tmp/p2",
        plannerMaxBudgetUsd: 1.5,
        planCheckerMaxBudgetUsd: 0.5,
        implementerMaxBudgetUsd: 3.0,
        reviewSidecarMaxBudgetUsd: 0.3,
      });
      expect(p).toBeDefined();
      expect(p!.plannerMaxBudgetUsd).toBe(1.5);
    });

    it("updateProject updates fields", () => {
      const p = createProject({ name: "P", rootPath: "/tmp/p" });
      const updated = updateProject(p!.id, { name: "Updated", rootPath: "/tmp/updated" });
      expect(updated!.name).toBe("Updated");
      expect(updated!.rootPath).toBe("/tmp/updated");
    });

    it("deleteProject removes project", () => {
      const p = createProject({ name: "Del", rootPath: "/tmp/del" });
      deleteProject(p!.id);
      expect(findProjectById(p!.id)).toBeUndefined();
    });

    it("findProjectByTaskId returns project for task", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(findProjectByTaskId(t!.id)!.id).toBe("proj-1");
    });

    it("findProjectByTaskId returns undefined for missing task", () => {
      expect(findProjectByTaskId("no-such-task")).toBeUndefined();
    });
  });

  // ── Activity / heartbeat / status ───────────────────────

  describe("appendTaskActivityLog", () => {
    it("appends to empty log", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      appendTaskActivityLog(t!.id, "line1");
      const found = findTaskById(t!.id);
      expect(found!.agentActivityLog).toBe("line1");
    });

    it("appends to existing log", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      appendTaskActivityLog(t!.id, "line1");
      appendTaskActivityLog(t!.id, "line2");
      const found = findTaskById(t!.id);
      expect(found!.agentActivityLog).toBe("line1\nline2");
    });
  });

  describe("updateTaskHeartbeat", () => {
    it("updates heartbeat timestamp", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      updateTaskHeartbeat(t!.id);
      const found = findTaskById(t!.id);
      expect(found!.lastHeartbeatAt).toBeDefined();
      expect(found!.updatedAt).toBeDefined();
    });
  });

  describe("updateTaskStatus", () => {
    it("updates status", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      updateTaskStatus(t!.id, "planning");
      expect(findTaskById(t!.id)!.status).toBe("planning");
    });

    it("updates status with extra fields", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      updateTaskStatus(t!.id, "blocked_external", {
        blockedReason: "waiting",
        blockedFromStatus: "planning",
      });
      const found = findTaskById(t!.id)!;
      expect(found.status).toBe("blocked_external");
      expect(found.blockedReason).toBe("waiting");
    });
  });

  // ── Token usage ─────────────────────────────────────────

  describe("incrementTaskTokenUsage", () => {
    it("increments token usage", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const delta = incrementTaskTokenUsage(t!.id, {
        input_tokens: 100,
        output_tokens: 50,
        total_cost_usd: 0.01,
      });
      expect(delta.input).toBe(100);
      expect(delta.output).toBe(50);
      const found = findTaskById(t!.id)!;
      expect(found.tokenInput).toBe(100);
      expect(found.tokenOutput).toBe(50);
      expect(found.tokenTotal).toBe(150);
    });

    it("skips update for zero usage", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const delta = incrementTaskTokenUsage(t!.id, {});
      expect(delta.total).toBe(0);
    });

    it("handles null usage", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const delta = incrementTaskTokenUsage(t!.id, null);
      expect(delta.total).toBe(0);
    });
  });

  // ── persistTaskPlanForTask ───────────────────────────────

  describe("persistTaskPlanForTask", () => {
    it("persists plan text for a task", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      const result = persistTaskPlanForTask({ taskId: t!.id, planText: "## Plan\n- step 1" });
      expect(result.updatedAt).toBeDefined();
      const found = findTaskById(t!.id);
      expect(found!.plan).toBe("## Plan\n- step 1");
    });

    it("clears plan with null", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      persistTaskPlanForTask({ taskId: t!.id, planText: "some plan" });
      persistTaskPlanForTask({ taskId: t!.id, planText: null });
      const found = findTaskById(t!.id);
      expect(found!.plan).toBe(null);
    });
  });

  // ── Coordinator candidate ────────────────────────────────

  describe("findCoordinatorTaskCandidate", () => {
    it("finds plan-checker candidates", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "pc-task",
          projectId: "proj-1",
          title: "Plan check",
          status: "plan_ready",
          autoMode: true,
          paused: false,
        })
        .run();
      const candidate = findCoordinatorTaskCandidate("plan-checker");
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe("pc-task");
    });

    it("finds reviewer candidates", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "rv-task",
          projectId: "proj-1",
          title: "Review",
          status: "review",
          paused: false,
        })
        .run();
      const candidate = findCoordinatorTaskCandidate("reviewer");
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe("rv-task");
    });
  });

  // ── Batch task selection ─────────────────────────────────

  describe("findCoordinatorTaskCandidates", () => {
    it("returns multiple candidates up to limit", () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "t1", projectId: "proj-1", title: "A", status: "planning", position: 1 }).run();
      db.insert(tasks).values({ id: "t2", projectId: "proj-1", title: "B", status: "planning", position: 2 }).run();
      db.insert(tasks).values({ id: "t3", projectId: "proj-1", title: "C", status: "planning", position: 3 }).run();

      const all = findCoordinatorTaskCandidates("planner", 10);
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe("t1");

      const limited = findCoordinatorTaskCandidates("planner", 2);
      expect(limited).toHaveLength(2);
    });

    it("excludes locked tasks", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks).values({ id: "locked", projectId: "proj-1", title: "Locked", status: "planning", lockedBy: "worker-1", lockedUntil: future }).run();
      db.insert(tasks).values({ id: "free", projectId: "proj-1", title: "Free", status: "planning" }).run();

      const candidates = findCoordinatorTaskCandidates("planner", 10);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("free");
    });

    it("includes tasks with expired locks", () => {
      const db = testDb.current;
      const past = new Date(Date.now() - 1000).toISOString();
      db.insert(tasks).values({ id: "stale-lock", projectId: "proj-1", title: "Stale", status: "planning", lockedBy: "dead-worker", lockedUntil: past }).run();

      const candidates = findCoordinatorTaskCandidates("planner", 10);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("stale-lock");
    });
  });

  // ── Task claiming ──────────────────────────────────────

  describe("claimTask", () => {
    it("claims an unlocked task", () => {
      const db = testDb.current;
      db.insert(tasks).values({ id: "claim-me", projectId: "proj-1", title: "Claim", status: "planning" }).run();

      const claimed = claimTask("claim-me", "coord-1", 600_000);
      expect(claimed).toBe(true);

      const task = findTaskById("claim-me");
      expect(task!.lockedBy).toBe("coord-1");
      expect(task!.lockedUntil).toBeTruthy();
    });

    it("rejects claim on already-locked task", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks).values({ id: "busy", projectId: "proj-1", title: "Busy", status: "planning", lockedBy: "coord-1", lockedUntil: future }).run();

      const claimed = claimTask("busy", "coord-2", 600_000);
      expect(claimed).toBe(false);

      const task = findTaskById("busy");
      expect(task!.lockedBy).toBe("coord-1");
    });

    it("claims task with expired lock", () => {
      const db = testDb.current;
      const past = new Date(Date.now() - 1000).toISOString();
      db.insert(tasks).values({ id: "expired", projectId: "proj-1", title: "Expired", status: "planning", lockedBy: "dead", lockedUntil: past }).run();

      const claimed = claimTask("expired", "coord-2", 600_000);
      expect(claimed).toBe(true);

      const task = findTaskById("expired");
      expect(task!.lockedBy).toBe("coord-2");
    });
  });

  describe("releaseTaskClaim", () => {
    it("clears lock fields", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks).values({ id: "release-me", projectId: "proj-1", title: "Release", status: "planning", lockedBy: "coord-1", lockedUntil: future }).run();

      releaseTaskClaim("release-me");

      const task = findTaskById("release-me");
      expect(task!.lockedBy).toBeNull();
      expect(task!.lockedUntil).toBeNull();
    });
  });

  describe("releaseStaleTaskClaims", () => {
    it("releases expired claims and returns count", () => {
      const db = testDb.current;
      const past = new Date(Date.now() - 1000).toISOString();
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks).values({ id: "stale1", projectId: "proj-1", title: "S1", status: "planning", lockedBy: "dead", lockedUntil: past }).run();
      db.insert(tasks).values({ id: "stale2", projectId: "proj-1", title: "S2", status: "planning", lockedBy: "dead", lockedUntil: past }).run();
      db.insert(tasks).values({ id: "active", projectId: "proj-1", title: "Active", status: "planning", lockedBy: "alive", lockedUntil: future, lastHeartbeatAt: new Date().toISOString() }).run();

      const released = releaseStaleTaskClaims();
      expect(released).toBe(2);

      expect(findTaskById("stale1")!.lockedBy).toBeNull();
      expect(findTaskById("stale2")!.lockedBy).toBeNull();
      expect(findTaskById("active")!.lockedBy).toBe("alive");
    });

    it("returns 0 when no stale claims", () => {
      expect(releaseStaleTaskClaims()).toBe(0);
    });

    it("releases claims with dead heartbeat and stale updatedAt", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      // Lock not expired, but heartbeat dead and updatedAt stale → should release
      db.insert(tasks).values({
        id: "dead-hb", projectId: "proj-1", title: "Dead HB", status: "implementing",
        lockedBy: "crashed-coord", lockedUntil: future,
        lastHeartbeatAt: staleTime, updatedAt: staleTime,
      }).run();

      const released = releaseStaleTaskClaims();
      expect(released).toBe(1);
      expect(findTaskById("dead-hb")!.lockedBy).toBeNull();
    });

    it("does NOT release fresh claims with null heartbeat", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();

      // Just claimed — updatedAt is fresh, heartbeat not yet set
      db.insert(tasks).values({
        id: "fresh", projectId: "proj-1", title: "Fresh", status: "planning",
        lockedBy: "coord-1", lockedUntil: future,
        lastHeartbeatAt: null, updatedAt: new Date().toISOString(),
      }).run();

      const released = releaseStaleTaskClaims();
      expect(released).toBe(0);
      expect(findTaskById("fresh")!.lockedBy).toBe("coord-1");
    });
  });

  // ── hasActiveLockedTaskForProject ──────────────────────

  describe("hasActiveLockedTaskForProject", () => {
    it("returns true when project has active lock", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks).values({
        id: "locked-1", projectId: "proj-1", title: "Locked", status: "planning",
        lockedBy: "coord-1", lockedUntil: future,
      }).run();

      expect(hasActiveLockedTaskForProject("proj-1")).toBe(true);
      expect(hasActiveLockedTaskForProject("proj-other")).toBe(false);
    });

    it("returns false when lock is expired", () => {
      const db = testDb.current;
      const past = new Date(Date.now() - 1000).toISOString();
      db.insert(tasks).values({
        id: "expired-1", projectId: "proj-1", title: "Expired", status: "planning",
        lockedBy: "coord-1", lockedUntil: past,
      }).run();

      expect(hasActiveLockedTaskForProject("proj-1")).toBe(false);
    });

    it("returns false when no tasks locked", () => {
      expect(hasActiveLockedTaskForProject("proj-1")).toBe(false);
    });
  });

  // ── renewTaskClaim ─────────────────────────────────────

  describe("renewTaskClaim", () => {
    it("extends lock expiry for the owning coordinator", () => {
      const db = testDb.current;
      const soon = new Date(Date.now() + 60_000).toISOString();
      db.insert(tasks).values({
        id: "renew-1", projectId: "proj-1", title: "R1", status: "implementing",
        lockedBy: "coord-1", lockedUntil: soon,
      }).run();

      renewTaskClaim("renew-1", "coord-1", 30 * 60 * 1000);

      const task = findTaskById("renew-1")!;
      expect(task.lockedBy).toBe("coord-1");
      // New expiry should be ~30 min from now, much later than the original 1 min
      const newExpiry = new Date(task.lockedUntil!).getTime();
      expect(newExpiry).toBeGreaterThan(Date.now() + 25 * 60 * 1000);
    });

    it("does not renew lock owned by a different coordinator", () => {
      const db = testDb.current;
      const soon = new Date(Date.now() + 60_000).toISOString();
      db.insert(tasks).values({
        id: "renew-other", projectId: "proj-1", title: "RO", status: "implementing",
        lockedBy: "coord-1", lockedUntil: soon,
      }).run();

      renewTaskClaim("renew-other", "coord-2", 30 * 60 * 1000);

      const task = findTaskById("renew-other")!;
      // Lock unchanged — still owned by coord-1 with original expiry
      expect(task.lockedBy).toBe("coord-1");
      expect(task.lockedUntil).toBe(soon);
    });

    it("does nothing for unlocked tasks", () => {
      const db = testDb.current;
      db.insert(tasks).values({
        id: "renew-2", projectId: "proj-1", title: "R2", status: "planning",
      }).run();

      renewTaskClaim("renew-2", "coord-1", 30 * 60 * 1000);

      const task = findTaskById("renew-2")!;
      expect(task.lockedBy).toBeNull();
      expect(task.lockedUntil).toBeNull();
    });
  });

  // ── Roadmap alias ───────────────────────────────────────

  describe("findTasksByRoadmapAlias", () => {
    it("finds tasks by roadmap alias", () => {
      createTask({
        projectId: "proj-1",
        title: "T1",
        description: "D",
        roadmapAlias: "feature-x",
      });
      createTask({
        projectId: "proj-1",
        title: "T2",
        description: "D",
        roadmapAlias: "feature-y",
      });
      expect(findTasksByRoadmapAlias("proj-1", "feature-x")).toHaveLength(1);
    });

    it("returns empty for non-matching alias", () => {
      expect(findTasksByRoadmapAlias("proj-1", "none")).toHaveLength(0);
    });
  });

  // ── Search ────────────────────────────────────────────────

  describe("searchTasks", () => {
    it("finds tasks by title", () => {
      createTask({ projectId: "proj-1", title: "Alpha feature", description: "desc" });
      createTask({ projectId: "proj-1", title: "Beta bugfix", description: "desc" });
      const results = searchTasks("Alpha");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Alpha feature");
    });

    it("finds tasks by description", () => {
      createTask({ projectId: "proj-1", title: "Task", description: "Fix the login flow" });
      const results = searchTasks("login");
      expect(results).toHaveLength(1);
    });

    it("is case-insensitive", () => {
      createTask({ projectId: "proj-1", title: "hello world", description: "" });
      const results = searchTasks("HELLO");
      expect(results).toHaveLength(1);
    });

    it("scopes search by project", () => {
      testDb.current
        .insert(projects)
        .values({ id: "proj-2", name: "Other", rootPath: "/tmp/other" })
        .run();
      createTask({ projectId: "proj-1", title: "Shared keyword", description: "" });
      createTask({ projectId: "proj-2", title: "Shared keyword", description: "" });
      const results = searchTasks("Shared", "proj-1");
      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe("proj-1");
    });

    it("returns empty for no matches", () => {
      createTask({ projectId: "proj-1", title: "Something", description: "" });
      expect(searchTasks("nonexistent")).toHaveLength(0);
    });

    it("limits results to 50", () => {
      for (let i = 0; i < 55; i++) {
        createTask({ projectId: "proj-1", title: `Match item ${i}`, description: "" });
      }
      const results = searchTasks("Match");
      expect(results).toHaveLength(50);
    });

    it("orders by updatedAt desc", () => {
      const t1 = createTask({ projectId: "proj-1", title: "Search order A", description: "" });
      const t2 = createTask({ projectId: "proj-1", title: "Search order B", description: "" });
      // Manually set updatedAt to control ordering
      if (t1 && t2) {
        setTaskFields(t1.id, { updatedAt: "2026-01-01T00:00:00.000Z" });
        setTaskFields(t2.id, { updatedAt: "2026-01-02T00:00:00.000Z" });
        const results = searchTasks("Search order");
        expect(results[0].id).toBe(t2.id);
        expect(results[1].id).toBe(t1.id);
      }
    });
  });

  // ── Sync timestamps ───────────────────────────────────────

  describe("touchLastSyncedAt", () => {
    it("sets lastSyncedAt timestamp", () => {
      const task = createTask({ projectId: "proj-1", title: "Sync", description: "" });
      expect(task).toBeDefined();
      expect(task!.lastSyncedAt).toBeNull();

      touchLastSyncedAt(task!.id);
      const updated = findTaskById(task!.id);
      expect(updated).toBeDefined();
      expect(updated!.lastSyncedAt).toBeTruthy();
      expect(new Date(updated!.lastSyncedAt!).getTime()).toBeGreaterThan(0);
    });

    it("updates lastSyncedAt on subsequent calls", () => {
      const task = createTask({ projectId: "proj-1", title: "Sync2", description: "" });
      touchLastSyncedAt(task!.id);
      const first = findTaskById(task!.id)!.lastSyncedAt;

      // Small delay to ensure different timestamp
      const later = new Date(Date.now() + 100).toISOString();
      setTaskFields(task!.id, { lastSyncedAt: later });
      const second = findTaskById(task!.id)!.lastSyncedAt;
      expect(second).not.toBe(first);
    });
  });

  // ── Millisecond precision ─────────────────────────────────

  describe("millisecond timestamp precision", () => {
    it("createdAt has millisecond precision", () => {
      const task = createTask({ projectId: "proj-1", title: "Precision", description: "" });
      expect(task).toBeDefined();
      // JS toISOString always includes milliseconds
      expect(task!.createdAt).toMatch(/\.\d{3}Z$/);
    });

    it("updatedAt has millisecond precision after update", () => {
      const task = createTask({ projectId: "proj-1", title: "Precision2", description: "" });
      const updated = updateTask(task!.id, { title: "Updated" });
      expect(updated).toBeDefined();
      expect(updated!.updatedAt).toMatch(/\.\d{3}Z$/);
    });
  });

  // ── Paginated list ────────────────────────────────────────

  describe("listTasksPaginated", () => {
    it("returns paginated results with total", () => {
      for (let i = 0; i < 5; i++) {
        createTask({ projectId: "proj-1", title: `Page task ${i}`, description: "" });
      }
      const result = listTasksPaginated({ limit: 2, offset: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
    });

    it("supports offset", () => {
      for (let i = 0; i < 5; i++) {
        createTask({ projectId: "proj-1", title: `Offset task ${i}`, description: "" });
      }
      const page1 = listTasksPaginated({ limit: 2, offset: 0 });
      const page2 = listTasksPaginated({ limit: 2, offset: 2 });
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });

    it("filters by projectId", () => {
      testDb.current
        .insert(projects)
        .values({ id: "proj-pg", name: "PG", rootPath: "/tmp/pg" })
        .run();
      createTask({ projectId: "proj-1", title: "P1", description: "" });
      createTask({ projectId: "proj-pg", title: "PG1", description: "" });
      const result = listTasksPaginated({ projectId: "proj-pg" });
      expect(result.total).toBe(1);
      expect(result.items[0].title).toBe("PG1");
    });

    it("filters by status", () => {
      const t = createTask({ projectId: "proj-1", title: "Status test", description: "" });
      setTaskFields(t!.id, { status: "planning" });
      createTask({ projectId: "proj-1", title: "Backlog", description: "" });
      const result = listTasksPaginated({ status: "planning" });
      expect(result.total).toBe(1);
    });

    it("caps limit at 100", () => {
      const result = listTasksPaginated({ limit: 999 });
      expect(result.limit).toBe(100);
    });

    it("defaults limit to 20", () => {
      const result = listTasksPaginated({});
      expect(result.limit).toBe(20);
    });

    it("returns summary fields without plan/description/logs", () => {
      createTask({ projectId: "proj-1", title: "Summary", description: "long desc" });
      const result = listTasksPaginated({});
      const item = result.items[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("title");
      expect(item).toHaveProperty("status");
      expect(item).not.toHaveProperty("plan");
      expect(item).not.toHaveProperty("description");
      expect(item).not.toHaveProperty("implementationLog");
      expect(item).not.toHaveProperty("agentActivityLog");
    });
  });

  // ── Paginated search ──────────────────────────────────────

  describe("searchTasksPaginated", () => {
    it("returns paginated search results", () => {
      for (let i = 0; i < 5; i++) {
        createTask({ projectId: "proj-1", title: `Searchable ${i}`, description: "" });
      }
      const result = searchTasksPaginated({ query: "Searchable", limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
    });

    it("supports offset in search", () => {
      for (let i = 0; i < 5; i++) {
        createTask({ projectId: "proj-1", title: `Find me ${i}`, description: "" });
      }
      const p1 = searchTasksPaginated({ query: "Find me", limit: 2, offset: 0 });
      const p2 = searchTasksPaginated({ query: "Find me", limit: 2, offset: 2 });
      expect(p1.items[0].id).not.toBe(p2.items[0].id);
    });

    it("caps limit at 50", () => {
      const result = searchTasksPaginated({ query: "x", limit: 999 });
      expect(result.limit).toBe(50);
    });
  });

  // ── Scheduler queries ────────────────────────────────────

  describe("scheduled tasks", () => {
    it("listDueScheduledTasks returns only due backlog tasks", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      const due = createTask({ projectId: "proj-1", title: "Due", description: "", scheduledAt: past });
      createTask({ projectId: "proj-1", title: "Not yet", description: "", scheduledAt: future });
      createTask({ projectId: "proj-1", title: "Unscheduled", description: "" });

      const rows = listDueScheduledTasks(new Date().toISOString());
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(due!.id);
      expect(rows).toHaveLength(1);
    });

    it("listDueScheduledTasks skips paused tasks", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = createTask({ projectId: "proj-1", title: "Due paused", description: "", paused: true, scheduledAt: past });
      expect(t).toBeDefined();
      // createTask path does not force paused=true into insert defaults — verify via setTaskFields
      setTaskFields(t!.id, { paused: true, scheduledAt: past });
      const rows = listDueScheduledTasks(new Date().toISOString());
      expect(rows.find((r) => r.id === t!.id)).toBeUndefined();
    });

    it("listDueScheduledTasks ignores non-backlog tasks", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = createTask({ projectId: "proj-1", title: "Planning", description: "", scheduledAt: past });
      updateTaskStatus(t!.id, "planning");
      const rows = listDueScheduledTasks(new Date().toISOString());
      expect(rows.find((r) => r.id === t!.id)).toBeUndefined();
    });

    it("clearScheduledAt nullifies the column", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = createTask({ projectId: "proj-1", title: "Due", description: "", scheduledAt: past });
      clearScheduledAt(t!.id);
      expect(findTaskById(t!.id)!.scheduledAt).toBeNull();
    });

    it("updateScheduledAt persists a value and clears with null", () => {
      const t = createTask({ projectId: "proj-1", title: "S", description: "" });
      const future = new Date(Date.now() + 3_600_000).toISOString();
      updateScheduledAt(t!.id, future);
      expect(findTaskById(t!.id)!.scheduledAt).toBe(future);
      updateScheduledAt(t!.id, null);
      expect(findTaskById(t!.id)!.scheduledAt).toBeNull();
    });
  });

  describe("auto-queue mode", () => {
    it("getAutoQueueMode defaults to false; setAutoQueueMode persists", () => {
      expect(getAutoQueueMode("proj-1")).toBe(false);
      setAutoQueueMode("proj-1", true);
      expect(getAutoQueueMode("proj-1")).toBe(true);
      setAutoQueueMode("proj-1", false);
      expect(getAutoQueueMode("proj-1")).toBe(false);
    });

    it("listAutoQueueProjects returns only enabled projects", () => {
      testDb.current
        .insert(projects)
        .values({ id: "proj-2", name: "P2", rootPath: "/tmp/p2" })
        .run();
      setAutoQueueMode("proj-2", true);
      const all = listAutoQueueProjects();
      expect(all.map((p) => p.id)).toEqual(["proj-2"]);
    });

    it("nextBacklogTaskByPosition picks the lowest-position backlog task", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      const b = createTask({ projectId: "proj-1", title: "B", description: "" });
      // createTask assigns decreasing positions; b should be lower than a
      const next = nextBacklogTaskByPosition("proj-1");
      expect(next).toBeDefined();
      expect(next!.position).toBeLessThanOrEqual(a!.position);
      expect([a!.id, b!.id]).toContain(next!.id);
    });

    it("nextBacklogTaskByPosition ignores tasks scheduled in the future", () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      createTask({ projectId: "proj-1", title: "Future", description: "", scheduledAt: future });
      const ready = createTask({ projectId: "proj-1", title: "Ready", description: "" });
      const next = nextBacklogTaskByPosition("proj-1");
      expect(next!.id).toBe(ready!.id);
    });

    it("countActivePipelineTasksForProject counts non-terminal pipeline statuses", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      const b = createTask({ projectId: "proj-1", title: "B", description: "" });
      const c = createTask({ projectId: "proj-1", title: "C", description: "" });
      const d = createTask({ projectId: "proj-1", title: "D", description: "" });
      // a stays in backlog (source — doesn't count)
      updateTaskStatus(b!.id, "planning");
      updateTaskStatus(c!.id, "implementing");
      updateTaskStatus(d!.id, "done");
      expect(countActivePipelineTasksForProject("proj-1")).toBe(2);
      expect(a).toBeDefined();
    });

    it("claimBacklogTaskForAdvance returns true exactly once and is idempotent on retries", () => {
      const t = createTask({ projectId: "proj-1", title: "Race", description: "" });
      const first = claimBacklogTaskForAdvance(t!.id);
      const second = claimBacklogTaskForAdvance(t!.id);
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(findTaskById(t!.id)?.status).toBe("planning");
    });

    it("claimBacklogTaskForAdvance refuses paused tasks", () => {
      const t = createTask({ projectId: "proj-1", title: "P", description: "" });
      setTaskFields(t!.id, { paused: true });
      expect(claimBacklogTaskForAdvance(t!.id)).toBe(false);
      expect(findTaskById(t!.id)?.status).toBe("backlog");
    });

    it("claimBacklogTaskForAdvance refuses non-backlog tasks", () => {
      const t = createTask({ projectId: "proj-1", title: "P", description: "" });
      updateTaskStatus(t!.id, "planning");
      expect(claimBacklogTaskForAdvance(t!.id)).toBe(false);
    });

    it("claimBacklogTaskForAdvance clears scheduledAt in the same write", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const t = createTask({
        projectId: "proj-1",
        title: "S",
        description: "",
        scheduledAt: future,
      });
      expect(claimBacklogTaskForAdvance(t!.id)).toBe(true);
      expect(findTaskById(t!.id)?.scheduledAt).toBeNull();
    });

    it("countActivePipelineTasksForProject includes blocked_external", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      updateTaskStatus(a!.id, "blocked_external");
      expect(countActivePipelineTasksForProject("proj-1")).toBe(1);
    });

    it("nextBacklogTaskByPosition skips paused tasks", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      setTaskFields(a!.id, { paused: true });
      const b = createTask({ projectId: "proj-1", title: "B", description: "" });
      const next = nextBacklogTaskByPosition("proj-1");
      expect(next!.id).toBe(b!.id);
    });
  });

  // ── toTaskSummary ─────────────────────────────────────────

  describe("codex index repositories", () => {
    it("upserts session and file index batches", () => {
      const sessionChanges = upsertCodexSessions([
        {
          sessionId: "codex-session-1",
          filePath: "/tmp/codex/s1.jsonl",
          title: "Session One",
          projectRoot: "/tmp/test",
          accountFingerprint: "acct-1",
          sourceUpdatedAt: "2026-04-23T10:00:00.000Z",
          sizeBytes: 100,
          mtimeMs: 1713866400000,
        },
      ]);
      const fileChanges = upsertCodexSessionFiles([
        {
          filePath: "/tmp/codex/s1.jsonl",
          sessionId: "codex-session-1",
          sizeBytes: 100,
          mtimeMs: 1713866400000,
          parsedOffset: 64,
          pendingTail: "",
          missing: false,
          importVersion: 1,
        },
      ]);

      expect(sessionChanges).toBeGreaterThan(0);
      expect(fileChanges).toBeGreaterThan(0);

      const sessionRow = testDb.current
        .select()
        .from(codexSessions)
        .where(eq(codexSessions.sessionId, "codex-session-1"))
        .get();
      const fileRow = testDb.current
        .select()
        .from(codexSessionFiles)
        .where(eq(codexSessionFiles.filePath, "/tmp/codex/s1.jsonl"))
        .get();

      expect(sessionRow?.projectRoot).toBe("/tmp/test");
      expect(fileRow?.parsedOffset).toBe(64);

      const allFileStates = listCodexSessionFileStates();
      const matchedStates = listCodexSessionFileStatesByPaths(["/tmp/codex/s1.jsonl"]);
      expect(allFileStates).toHaveLength(1);
      expect(matchedStates).toHaveLength(1);

      const deleted = deleteCodexSessionsByFilePaths(["/tmp/codex/s1.jsonl"]);
      expect(deleted).toBe(1);
    });

    it("upserts heads, appends history, and prunes retention", () => {
      const snapshotA = makeCodexSnapshot("2026-04-23T10:00:00.000Z");
      const snapshotB = makeCodexSnapshot("2026-04-23T11:00:00.000Z");
      const snapshotC = makeCodexSnapshot("2026-04-23T12:00:00.000Z");

      const headChanges = upsertCodexLimitHeads([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: snapshotA,
          observedAt: "2026-04-23T10:00:00.000Z",
        },
      ]);
      const appended = appendCodexLimitHistory([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: snapshotA,
          observedAt: "2026-04-23T10:00:00.000Z",
        },
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: snapshotB,
          observedAt: "2026-04-23T11:00:00.000Z",
        },
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: snapshotC,
          observedAt: "2026-04-23T12:00:00.000Z",
        },
      ]);

      expect(headChanges).toBeGreaterThan(0);
      expect(appended).toBe(3);

      const headKey = testDb.current
        .select({ headKey: codexLimitHeads.headKey })
        .from(codexLimitHeads)
        .where(eq(codexLimitHeads.accountFingerprint, "acct-1"))
        .get()?.headKey;
      expect(headKey).toBeDefined();

      const deletedByHead = pruneCodexLimitHistoryByHead({
        headKey: headKey!,
        keepLatest: 2,
      });
      expect(deletedByHead).toBe(1);

      const retainedRows = testDb.current
        .select()
        .from(codexLimitHistory)
        .where(eq(codexLimitHistory.headKey, headKey!))
        .all();
      expect(retainedRows).toHaveLength(2);

      appendCodexLimitHistory([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: makeCodexSnapshot("2026-04-23T13:00:00.000Z"),
          observedAt: "2026-04-23T13:00:00.000Z",
        },
      ]);
      const deletedByGlobalRetention = pruneCodexLimitHistoryRetention(2);
      expect(deletedByGlobalRetention).toBeGreaterThanOrEqual(1);
    });

    it("deletes stale limit heads and history by source file path", () => {
      const snapshot = makeCodexSnapshot("2026-04-23T10:00:00.000Z");
      upsertCodexLimitHeads([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot,
          observedAt: snapshot.checkedAt,
          filePath: "/tmp/codex/stale.jsonl",
        },
      ]);
      appendCodexLimitHistory([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot,
          observedAt: snapshot.checkedAt,
          filePath: "/tmp/codex/stale.jsonl",
        },
      ]);

      expect(listCodexLimitHeadScopesByFilePaths(["/tmp/codex/stale.jsonl"])).toEqual([
        expect.objectContaining({
          projectRoot: "/tmp/test",
          observedAt: snapshot.checkedAt,
          filePath: "/tmp/codex/stale.jsonl",
        }),
      ]);
      expect(deleteCodexLimitHeadsByFilePaths(["/tmp/codex/stale.jsonl"])).toBe(1);
      expect(deleteCodexLimitHistoryByFilePaths(["/tmp/codex/stale.jsonl"])).toBe(1);

      const remainingHeads = testDb.current.select().from(codexLimitHeads).all();
      const remainingHistory = testDb.current.select().from(codexLimitHistory).all();
      expect(remainingHeads).toHaveLength(0);
      expect(remainingHistory).toHaveLength(0);
    });

    it("deletes stale codex limit rows by observed time and returns deleted scopes", () => {
      const oldSnapshot = makeCodexSnapshot("2026-04-10T10:00:00.000Z");
      const freshSnapshot = makeCodexSnapshot("2026-04-20T10:00:00.000Z");
      upsertCodexLimitHeads([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: oldSnapshot,
          observedAt: oldSnapshot.checkedAt,
          filePath: "/tmp/codex/old.jsonl",
        },
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex_bengalfox",
          snapshot: freshSnapshot,
          observedAt: freshSnapshot.checkedAt,
          filePath: "/tmp/codex/fresh.jsonl",
        },
      ]);
      appendCodexLimitHistory([
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex",
          snapshot: oldSnapshot,
          observedAt: oldSnapshot.checkedAt,
          filePath: "/tmp/codex/old.jsonl",
        },
        {
          accountFingerprint: "acct-1",
          projectRoot: "/tmp/test",
          limitId: "codex_bengalfox",
          snapshot: freshSnapshot,
          observedAt: freshSnapshot.checkedAt,
          filePath: "/tmp/codex/fresh.jsonl",
        },
      ]);

      const result = pruneCodexLimitRowsBeforeObservedAt("2026-04-17T00:00:00.000Z");

      expect(result).toEqual(
        expect.objectContaining({
          headRowsDeleted: 1,
          historyRowsDeleted: 1,
          deletedScopes: [
            expect.objectContaining({
              projectRoot: "/tmp/test",
              filePath: "/tmp/codex/old.jsonl",
              observedAt: oldSnapshot.checkedAt,
            }),
          ],
        }),
      );
      expect(testDb.current.select().from(codexLimitHeads).all()).toEqual([
        expect.objectContaining({ filePath: "/tmp/codex/fresh.jsonl" }),
      ]);
      expect(testDb.current.select().from(codexLimitHistory).all()).toEqual([
        expect.objectContaining({ filePath: "/tmp/codex/fresh.jsonl" }),
      ]);
    });

    it("prunes stale codex session rows but keeps file lookups linked to saved web chats", () => {
      createChatSession({
        projectId: "proj-1",
        title: "Linked runtime chat",
        runtimeSessionId: "codex-linked",
      });
      upsertCodexSessions([
        {
          sessionId: "codex-linked",
          filePath: "/tmp/codex/linked.jsonl",
          projectRoot: "/tmp/test",
          sourceUpdatedAt: "2026-04-01T10:00:00.000Z",
          sizeBytes: 100,
          mtimeMs: 100,
        },
        {
          sessionId: "codex-unlinked",
          filePath: "/tmp/codex/unlinked.jsonl",
          projectRoot: "/tmp/test",
          sourceUpdatedAt: "2026-04-01T10:00:00.000Z",
          sizeBytes: 100,
          mtimeMs: 100,
        },
        {
          sessionId: "codex-fresh",
          filePath: "/tmp/codex/fresh.jsonl",
          projectRoot: "/tmp/test",
          sourceUpdatedAt: "2026-04-20T10:00:00.000Z",
          sizeBytes: 100,
          mtimeMs: 1_000,
        },
      ]);
      upsertCodexSessionFiles([
        {
          filePath: "/tmp/codex/linked.jsonl",
          sessionId: null,
          sizeBytes: 100,
          mtimeMs: 100,
          parsedOffset: 100,
          pendingTail: "",
          missing: false,
          importVersion: 1,
        },
        {
          filePath: "/tmp/codex/unlinked.jsonl",
          sessionId: "codex-unlinked",
          sizeBytes: 100,
          mtimeMs: 100,
          parsedOffset: 100,
          pendingTail: "",
          missing: false,
          importVersion: 1,
        },
        {
          filePath: "/tmp/codex/fresh.jsonl",
          sessionId: "codex-fresh",
          sizeBytes: 100,
          mtimeMs: 1_000,
          parsedOffset: 100,
          pendingTail: "",
          missing: false,
          importVersion: 1,
        },
      ]);

      const result = pruneStaleCodexSessionIndexRows({ mtimeBeforeMs: 500 });

      expect(result).toEqual({
        sessionRowsDeleted: 1,
        fileRowsDeleted: 1,
        linkedRowsRetained: 1,
      });
      expect(testDb.current.select().from(codexSessions).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: "codex-linked" }),
          expect.objectContaining({ sessionId: "codex-fresh" }),
        ]),
      );
      expect(
        testDb.current
          .select()
          .from(codexSessions)
          .where(eq(codexSessions.sessionId, "codex-unlinked"))
          .get(),
      ).toBeUndefined();
      expect(
        testDb.current
          .select()
          .from(codexSessionFiles)
          .where(eq(codexSessionFiles.filePath, "/tmp/codex/linked.jsonl"))
          .get(),
      ).toBeDefined();
    });

    it("upserts and resolves index cursors with parsed JSON", () => {
      const saved = upsertCodexIndexCursor({
        cursorKey: "codex:reconcile",
        cursorValue: "12345",
        cursorJson: { watermark: "w1", pass: 2 },
      });
      expect(saved).toBeDefined();
      expect(saved?.cursorValue).toBe("12345");
      expect(saved?.cursorJson).toEqual({ watermark: "w1", pass: 2 });

      const loaded = findCodexIndexCursor("codex:reconcile");
      expect(loaded).toBeDefined();
      expect(loaded?.cursorJson).toEqual({ watermark: "w1", pass: 2 });
    });
  });

  describe("toTaskSummary", () => {
    it("parses tags from JSON string", () => {
      createTask({ projectId: "proj-1", title: "Tagged", description: "", tags: ["a", "b"] });
      const result = listTasksPaginated({});
      const summary = toTaskSummary(result.items[0]);
      expect(Array.isArray(summary.tags)).toBe(true);
      expect(summary.tags).toContain("a");
    });
  });
});
