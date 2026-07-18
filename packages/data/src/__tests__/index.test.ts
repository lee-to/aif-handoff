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
  tryStartQaRun,
  resetStaleQaRuns,
  setTaskFields,
  deleteTask,
  findTaskById,
  listTasks,
  listTaskListItems,
  toTaskResponse,
  toCommentResponse,
  listTaskComments,
  createTaskComment,
  updateTaskComment,
  getLatestHumanComment,
  getLatestReworkComment,
  listProjects,
  listProjectTaskOverviews,
  findProjectById,
  createProject,
  updateProject,
  updateProjectOrganization,
  deleteProject,
  findProjectByTaskId,
  appendTaskActivityLog,
  updateTaskHeartbeat,
  updateTaskStatus,
  saveTaskActiveRuntimeSelection,
  getTaskActiveRuntimeSelection,
  clearTaskActiveRuntimeSelection,
  incrementTaskTokenUsage,
  findTasksByRoadmapAlias,
  persistTaskPlanForTask,
  findCoordinatorTaskCandidate,
  findCoordinatorTaskCandidates,
  findCoordinatorTaskCandidatesForProject,
  listCoordinatorActionableProjectIds,
  claimTask,
  claimCoordinatorTaskIfEligible,
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
  getMinBacklogPosition,
  nextBacklogTaskByPosition,
  listAutoQueueProjects,
  countActivePipelineTasksForProject,
  hasActiveBranchBoundTasksForProject,
  claimBacklogTaskForAdvance,
  createChatSession,
  createRuntimeWarmupSession,
  markRuntimeWarmupSessionReady,
  markRuntimeWarmupSessionFailed,
  clearActiveRuntimeWarmupSessions,
  expireStaleRuntimeWarmupSessions,
  findActiveReadyRuntimeWarmupSession,
  findRuntimeWarmupSessionById,
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

  describe("listTaskListItems", () => {
    it("returns lightweight task list items scoped to a project", () => {
      seedProject("proj-2");
      const withPlan = createTask({
        projectId: "proj-1",
        title: "A",
        description: "Board description",
        priority: 2,
        tags: ["roadmap"],
        roadmapAlias: "v1",
      })!;
      setTaskFields(withPlan.id, {
        plan: "## Plan",
        implementationLog: "heavy implementation log",
        reviewComments: "heavy review comments",
        agentActivityLog: "heavy activity log",
      });
      updateTask(withPlan.id, {
        tokenInput: 10,
        tokenOutput: 20,
        tokenTotal: 30,
        costUsd: 0.12,
      });
      createTask({ projectId: "proj-2", title: "B", description: "Other project" });

      const result = listTaskListItems("proj-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: withPlan.id,
        projectId: "proj-1",
        title: "A",
        description: "Board description",
        hasPlan: true,
        tokenInput: 10,
        tokenOutput: 20,
        tokenTotal: 30,
        costUsd: 0.12,
        tags: ["roadmap"],
        roadmapAlias: "v1",
      });
      expect(result[0]).not.toHaveProperty("plan");
      expect(result[0]).not.toHaveProperty("implementationLog");
      expect(result[0]).not.toHaveProperty("reviewComments");
      expect(result[0]).not.toHaveProperty("agentActivityLog");
      expect(result[0]).not.toHaveProperty("attachments");
      expect(result[0]).not.toHaveProperty("runtimeOptions");
    });

    it("sorts by kanban status order before position", () => {
      const planning = createTask({ projectId: "proj-1", title: "Planning", description: "" })!;
      const blocked = createTask({ projectId: "proj-1", title: "Blocked", description: "" })!;
      const backlog = createTask({ projectId: "proj-1", title: "Backlog", description: "" })!;

      updateTaskStatus(planning.id, "planning");
      updateTaskStatus(blocked.id, "blocked_external", {
        blockedFromStatus: "planning",
        blockedReason: "rate limit",
      });

      const result = listTaskListItems("proj-1");

      expect(result.map((task) => task.id)).toEqual([backlog.id, planning.id, blocked.id]);
    });
  });

  describe("listProjectTaskOverviews", () => {
    it("returns compact per-project aggregates and limited previews", () => {
      seedProject("proj-2");
      createTask({
        projectId: "proj-1",
        title: "Backlog A",
        description: "D",
        isFix: true,
        tags: ["x"],
      });
      const firstBacklog = createTask({
        projectId: "proj-1",
        title: "Backlog first by position",
        description: "D",
        position: 10,
      })!;
      const backlog = listTasks("proj-1").find((task) => task.title === "Backlog A")!;
      updateTask(backlog.id, {
        tokenInput: 5,
        tokenOutput: 6,
        tokenTotal: 11,
      });
      const done = createTask({
        projectId: "proj-1",
        title: "Done B",
        description: "D",
        autoMode: false,
      })!;
      updateTaskStatus(done.id, "done", {
        retryCount: 2,
      });
      updateTask(done.id, {
        tokenInput: 10,
        tokenOutput: 15,
        tokenTotal: 25,
        costUsd: 0.5,
      });
      createTask({ projectId: "proj-2", title: "Other project", description: "D" });

      const overviews = listProjectTaskOverviews(1);
      const proj1 = overviews.find((overview) => overview.projectId === "proj-1")!;
      const proj2 = overviews.find((overview) => overview.projectId === "proj-2")!;

      expect(proj1.totalTasks).toBe(3);
      expect(proj1.completedTasks).toBe(1);
      expect(proj1.backlogTasks).toBe(2);
      expect(proj1.fixTasks).toBe(1);
      expect(proj1.totalRetries).toBe(2);
      expect(proj1.totalTokenInput).toBe(15);
      expect(proj1.totalTokenOutput).toBe(21);
      expect(proj1.totalTokenTotal).toBe(36);
      expect(proj1.totalCostUsd).toBe(0.5);
      expect(proj1.statusCounts.backlog).toBe(2);
      expect(proj1.statusCounts.done).toBe(1);
      expect(proj1.statusPreviews.backlog).toEqual([
        { id: firstBacklog.id, title: "Backlog first by position" },
      ]);
      expect(proj1.statusPreviews.done).toEqual([{ id: done.id, title: "Done B" }]);
      expect(proj2.totalTasks).toBe(1);
    });

    it("returns the latest task activity timestamp per project", () => {
      const older = createTask({ projectId: "proj-1", title: "Older", description: "D" })!;
      const newer = createTask({ projectId: "proj-1", title: "Newer", description: "D" })!;
      testDb.current
        .update(tasks)
        .set({ updatedAt: "2026-01-01T10:00:00.000Z" })
        .where(eq(tasks.id, older.id))
        .run();
      testDb.current
        .update(tasks)
        .set({ updatedAt: "2026-01-02T10:00:00.000Z" })
        .where(eq(tasks.id, newer.id))
        .run();

      expect(listProjectTaskOverviews()[0]?.lastActivityAt).toBe("2026-01-02T10:00:00.000Z");
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

  describe("tryStartQaRun", () => {
    it("claims the running slot from a non-running status and returns true", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(tryStartQaRun(t!.id)).toBe(true);
      expect(findTaskById(t!.id)!.qaStatus).toBe("running");
    });

    it("is mutually exclusive: a second claim while running returns false", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(tryStartQaRun(t!.id)).toBe(true);
      // Already running — the compare-and-set affects no rows.
      expect(tryStartQaRun(t!.id)).toBe(false);
      expect(findTaskById(t!.id)!.qaStatus).toBe("running");
    });

    it("can re-claim after the run finishes (status back to done/error)", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(tryStartQaRun(t!.id)).toBe(true);
      updateTask(t!.id, { qaStatus: "done" });
      expect(tryStartQaRun(t!.id)).toBe(true);
    });

    it("returns false for an unknown task id (no row to flip)", () => {
      expect(tryStartQaRun("ghost")).toBe(false);
    });
  });

  describe("resetStaleQaRuns", () => {
    it("flips every running row to error and returns the count", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "D" });
      const b = createTask({ projectId: "proj-1", title: "B", description: "D" });
      expect(tryStartQaRun(a!.id)).toBe(true);
      expect(tryStartQaRun(b!.id)).toBe(true);
      expect(resetStaleQaRuns()).toBe(2);
      expect(findTaskById(a!.id)!.qaStatus).toBe("error");
      expect(findTaskById(b!.id)!.qaStatus).toBe("error");
    });

    it("leaves non-running statuses untouched and returns 0 when nothing is stale", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      updateTask(t!.id, { qaStatus: "done" });
      expect(resetStaleQaRuns()).toBe(0);
      expect(findTaskById(t!.id)!.qaStatus).toBe("done");
    });

    it("unblocks the QA claim: the recovered task can start QA again", () => {
      const t = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(tryStartQaRun(t!.id)).toBe(true);
      resetStaleQaRuns();
      // Stale "running" released — the compare-and-set can win again.
      expect(tryStartQaRun(t!.id)).toBe(true);
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

  describe("active runtime selection", () => {
    it("persists and clears a stage-scoped runtime selection", () => {
      const task = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(task).toBeDefined();

      updateTaskStatus(task!.id, "implementing");
      saveTaskActiveRuntimeSelection(task!.id, {
        status: "implementing",
        profileMode: "task",
        source: "project_default",
        profileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: "claude-sonnet",
        baseUrl: null,
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        headers: {},
        options: { effort: "medium" },
        pinnedAt: "2026-05-13T00:00:00.000Z",
      });

      expect(getTaskActiveRuntimeSelection(task!.id)).toEqual(
        expect.objectContaining({
          status: "implementing",
          profileMode: "task",
          runtimeId: "claude",
          model: "claude-sonnet",
          options: { effort: "medium" },
        }),
      );

      clearTaskActiveRuntimeSelection(task!.id);
      expect(getTaskActiveRuntimeSelection(task!.id)).toBeNull();
    });

    it("ignores malformed active runtime selection payloads", () => {
      const task = createTask({ projectId: "proj-1", title: "T", description: "D" });
      expect(task).toBeDefined();

      setTaskFields(task!.id, {
        activeRuntimeStatus: "implementing",
        activeRuntimeSelectionJson: JSON.stringify({ status: "implementing" }),
      });

      expect(getTaskActiveRuntimeSelection(task!.id)).toBeNull();
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

    it("listProjects returns projects in deterministic case-insensitive name order", () => {
      testDb.current.delete(projects).run();
      testDb.current
        .insert(projects)
        .values([
          { id: "zulu-2", name: "zulu", rootPath: "/tmp/zulu-2" },
          { id: "alpha", name: "Alpha", rootPath: "/tmp/alpha" },
          { id: "zulu-1", name: "Zulu", rootPath: "/tmp/zulu-1" },
        ])
        .run();

      expect(listProjects().map((project) => project.id)).toEqual([
        "alpha",
        "zulu-1",
        "zulu-2",
      ]);
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

    it("updates project pin and group organization without changing core fields", () => {
      const pinned = updateProjectOrganization("proj-1", {
        pinned: true,
        groupName: "  Platform  ",
      });

      expect(pinned).toMatchObject({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/test",
        groupName: "Platform",
      });
      expect(pinned?.pinnedAt).toBeTruthy();

      const pinnedAgain = updateProjectOrganization("proj-1", { pinned: true });
      expect(pinnedAgain?.pinnedAt).toBe(pinned?.pinnedAt);

      const cleared = updateProjectOrganization("proj-1", { pinned: false, groupName: "" });
      expect(cleared?.pinnedAt).toBeNull();
      expect(cleared?.groupName).toBeNull();
    });

    it("returns undefined when organizing a missing project", () => {
      expect(updateProjectOrganization("missing", { pinned: true })).toBeUndefined();
    });

    it("updateProject preserves omitted runtime defaults and clears explicit nulls", () => {
      const p = createProject({
        name: "P",
        rootPath: "/tmp/p",
        defaultTaskRuntimeProfileId: "task-profile",
        defaultPlanRuntimeProfileId: "plan-profile",
        defaultReviewRuntimeProfileId: "review-profile",
        defaultChatRuntimeProfileId: "chat-profile",
      });

      const renamed = updateProject(p!.id, { name: "Renamed", rootPath: "/tmp/renamed" });
      expect(renamed!.defaultTaskRuntimeProfileId).toBe("task-profile");
      expect(renamed!.defaultPlanRuntimeProfileId).toBe("plan-profile");
      expect(renamed!.defaultReviewRuntimeProfileId).toBe("review-profile");
      expect(renamed!.defaultChatRuntimeProfileId).toBe("chat-profile");

      const cleared = updateProject(p!.id, {
        name: "Renamed",
        rootPath: "/tmp/renamed",
        defaultPlanRuntimeProfileId: null,
      });
      expect(cleared!.defaultTaskRuntimeProfileId).toBe("task-profile");
      expect(cleared!.defaultPlanRuntimeProfileId).toBeNull();
      expect(cleared!.defaultReviewRuntimeProfileId).toBe("review-profile");
      expect(cleared!.defaultChatRuntimeProfileId).toBe("chat-profile");
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

    it("returns empty project-scoped candidates and lanes when no tasks are actionable", () => {
      expect(findCoordinatorTaskCandidatesForProject("proj-1", "planner", 10)).toEqual([]);
      expect(listCoordinatorActionableProjectIds(10)).toEqual([]);
    });

    it("returns candidates for one project without being crowded by another project", () => {
      const db = testDb.current;
      db.insert(projects)
        .values({ id: "proj-2", name: "Project 2", rootPath: "/tmp/proj-2" })
        .run();
      db.insert(tasks)
        .values({ id: "p1-task", projectId: "proj-1", title: "P1", status: "planning", position: 10 })
        .run();
      db.insert(tasks)
        .values({ id: "p2-task", projectId: "proj-2", title: "P2", status: "planning", position: 1 })
        .run();

      const candidates = findCoordinatorTaskCandidatesForProject("proj-1", "planner", 10);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("p1-task");
    });

    it("lists actionable project lanes ordered by oldest waiting task", () => {
      const db = testDb.current;
      const oldest = "2026-01-01T00:00:00.000Z";
      const newer = "2026-01-02T00:00:00.000Z";
      db.insert(projects)
        .values({ id: "proj-2", name: "Project 2", rootPath: "/tmp/proj-2" })
        .run();
      db.insert(projects)
        .values({ id: "proj-3", name: "Project 3", rootPath: "/tmp/proj-3" })
        .run();
      db.insert(tasks)
        .values({
          id: "newer-low-position",
          projectId: "proj-1",
          title: "Newer low position",
          status: "planning",
          position: 1,
          createdAt: newer,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "oldest-high-position",
          projectId: "proj-2",
          title: "Oldest high position",
          status: "review",
          position: 30,
          createdAt: oldest,
        })
        .run();
      db.insert(tasks)
        .values({
          id: "locked",
          projectId: "proj-3",
          title: "Locked",
          status: "planning",
          position: 0,
          lockedBy: "worker",
          lockedUntil: new Date(Date.now() + 60_000).toISOString(),
          createdAt: "2025-12-31T00:00:00.000Z",
        })
        .run();

      expect(listCoordinatorActionableProjectIds(10)).toEqual(["proj-2", "proj-1"]);
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

  describe("claimCoordinatorTaskIfEligible", () => {
    it("atomically claims an eligible task and returns its fresh row", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "coordinator-claim",
          projectId: "proj-1",
          title: "Original title",
          status: "review",
        })
        .run();
      db.update(tasks)
        .set({ title: "Fresh title" })
        .where(eq(tasks.id, "coordinator-claim"))
        .run();

      const claimed = claimCoordinatorTaskIfEligible({
        taskId: "coordinator-claim",
        expectedProjectId: "proj-1",
        expectedStatus: "review",
        coordinatorId: "coord-1",
        lockDurationMs: 600_000,
      });

      expect(claimed).toMatchObject({
        id: "coordinator-claim",
        title: "Fresh title",
        status: "review",
        paused: false,
        lockedBy: "coord-1",
      });
      expect(claimed?.lockedUntil).toBeTruthy();
    });

    it("rejects stale project, status, pause, auto-mode, lock, and missing-row snapshots", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 60_000).toISOString();
      const candidates = [
        {
          id: "wrong-project",
          values: { projectId: "proj-2", status: "review" as const },
          expectedProjectId: "proj-1",
          expectedStatus: "review" as const,
        },
        {
          id: "wrong-status",
          values: { projectId: "proj-1", status: "done" as const },
          expectedProjectId: "proj-1",
          expectedStatus: "review" as const,
        },
        {
          id: "paused",
          values: { projectId: "proj-1", status: "review" as const, paused: true },
          expectedProjectId: "proj-1",
          expectedStatus: "review" as const,
        },
        {
          id: "auto-mode-changed",
          values: { projectId: "proj-1", status: "plan_ready" as const, autoMode: false },
          expectedProjectId: "proj-1",
          expectedStatus: "plan_ready" as const,
          expectedAutoMode: true,
        },
        {
          id: "actively-locked",
          values: {
            projectId: "proj-1",
            status: "review" as const,
            lockedBy: "other-coordinator",
            lockedUntil: future,
          },
          expectedProjectId: "proj-1",
          expectedStatus: "review" as const,
        },
      ];

      for (const candidate of candidates) {
        db.insert(tasks)
          .values({ id: candidate.id, title: candidate.id, ...candidate.values })
          .run();

        expect(
          claimCoordinatorTaskIfEligible({
            taskId: candidate.id,
            expectedProjectId: candidate.expectedProjectId,
            expectedStatus: candidate.expectedStatus,
            expectedAutoMode: candidate.expectedAutoMode,
            coordinatorId: "coord-1",
            lockDurationMs: 600_000,
          }),
        ).toBeUndefined();
        expect(findTaskById(candidate.id)?.lockedBy).toBe(
          "lockedBy" in candidate.values ? candidate.values.lockedBy : null,
        );
      }

      expect(
        claimCoordinatorTaskIfEligible({
          taskId: "missing-task",
          expectedProjectId: "proj-1",
          expectedStatus: "review",
          coordinatorId: "coord-1",
          lockDurationMs: 600_000,
        }),
      ).toBeUndefined();
    });

    it("claims an eligible task with an expired lock", () => {
      const db = testDb.current;
      db.insert(tasks)
        .values({
          id: "expired-coordinator-claim",
          projectId: "proj-1",
          title: "Expired coordinator claim",
          status: "planning",
          lockedBy: "dead-coordinator",
          lockedUntil: new Date(Date.now() - 1_000).toISOString(),
        })
        .run();

      const claimed = claimCoordinatorTaskIfEligible({
        taskId: "expired-coordinator-claim",
        expectedProjectId: "proj-1",
        expectedStatus: "planning",
        coordinatorId: "coord-1",
        lockDurationMs: 600_000,
      });

      expect(claimed?.lockedBy).toBe("coord-1");
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

    it("does not clear a claim owned by another coordinator", () => {
      const db = testDb.current;
      const future = new Date(Date.now() + 3600000).toISOString();
      db.insert(tasks)
        .values({
          id: "owned-release",
          projectId: "proj-1",
          title: "Owned release",
          status: "planning",
          lockedBy: "coord-2",
          lockedUntil: future,
        })
        .run();

      releaseTaskClaim("owned-release", "coord-1");

      expect(findTaskById("owned-release")?.lockedBy).toBe("coord-2");
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

    it("createTask appends default backlog positions per project and keeps auto-queue FIFO", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      const b = createTask({ projectId: "proj-1", title: "B", description: "" });
      seedProject("proj-2");
      const otherProjectTask = createTask({ projectId: "proj-2", title: "Other", description: "" });
      const c = createTask({ projectId: "proj-1", title: "C", description: "" });

      expect([a, b, c].map((task) => task?.position)).toEqual([1100, 1200, 1300]);
      expect(otherProjectTask?.position).toBe(1100);
      expect(nextBacklogTaskByPosition("proj-1")?.id).toBe(a?.id);
    });

    it("createTask honors an explicit position override for batch import callers", () => {
      createTask({ projectId: "proj-1", title: "Default", description: "" });
      const positioned = createTask({
        projectId: "proj-1",
        title: "Positioned",
        description: "",
        position: 123,
      });

      expect(positioned?.position).toBe(123);
    });

    it("getMinBacklogPosition returns null for empty backlog and the project minimum otherwise", () => {
      expect(getMinBacklogPosition("proj-1")).toBeNull();
      seedProject("proj-2");
      createTask({ projectId: "proj-1", title: "Later", description: "", position: 500 });
      createTask({ projectId: "proj-1", title: "Earlier", description: "", position: 100 });
      createTask({ projectId: "proj-2", title: "Other project", description: "", position: -100 });

      expect(getMinBacklogPosition("proj-1")).toBe(100);
      expect(getMinBacklogPosition("proj-2")).toBe(-100);
    });

    it("nextBacklogTaskByPosition ignores tasks scheduled in the future", () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      createTask({ projectId: "proj-1", title: "Future", description: "", scheduledAt: future });
      const ready = createTask({ projectId: "proj-1", title: "Ready", description: "" });
      const next = nextBacklogTaskByPosition("proj-1");
      expect(next!.id).toBe(ready!.id);
    });

    it("nextBacklogTaskByPosition breaks position ties by createdAt", () => {
      testDb.current
        .insert(tasks)
        .values([
          {
            id: "later-created",
            projectId: "proj-1",
            title: "Later",
            status: "backlog",
            position: 100,
            createdAt: "2026-06-23T00:00:02.000Z",
          },
          {
            id: "earlier-created",
            projectId: "proj-1",
            title: "Earlier",
            status: "backlog",
            position: 100,
            createdAt: "2026-06-23T00:00:01.000Z",
          },
        ])
        .run();

      expect(nextBacklogTaskByPosition("proj-1")?.id).toBe("earlier-created");
    });

    it("nextBacklogTaskByPosition breaks identical position and createdAt ties by id", () => {
      const createdAt = "2026-06-23T00:00:01.000Z";
      testDb.current
        .insert(tasks)
        .values([
          {
            id: "task-b",
            projectId: "proj-1",
            title: "Task B",
            status: "backlog",
            position: 100,
            createdAt,
          },
          {
            id: "task-a",
            projectId: "proj-1",
            title: "Task A",
            status: "backlog",
            position: 100,
            createdAt,
          },
        ])
        .run();

      expect(nextBacklogTaskByPosition("proj-1")?.id).toBe("task-a");
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

    it("hasActiveBranchBoundTasksForProject returns false when no task has a branchName", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      updateTaskStatus(a!.id, "implementing");
      expect(hasActiveBranchBoundTasksForProject("proj-1")).toBe(false);
    });

    it("hasActiveBranchBoundTasksForProject true once a branch-bound task is in flight", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      setTaskFields(a!.id, { branchName: "feature/a" });
      updateTaskStatus(a!.id, "implementing");
      expect(hasActiveBranchBoundTasksForProject("proj-1")).toBe(true);
    });

    it("hasActiveBranchBoundTasksForProject ignores isolated worktree-bound tasks", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      setTaskFields(a!.id, { branchName: "feature/a", worktreePath: "/tmp/a-worktree" });
      updateTaskStatus(a!.id, "implementing");
      expect(hasActiveBranchBoundTasksForProject("proj-1")).toBe(false);
    });

    it("hasActiveBranchBoundTasksForProject true for a queued backlog task that already has branchName", () => {
      // accept_existing_plan / replan can leave a branch-bound task in
      // backlog briefly; serialization must already kick in.
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      setTaskFields(a!.id, { branchName: "feature/a-prepared" });
      expect(hasActiveBranchBoundTasksForProject("proj-1")).toBe(true);
    });

    it("hasActiveBranchBoundTasksForProject false when bound tasks are terminal (done)", () => {
      const a = createTask({ projectId: "proj-1", title: "A", description: "" });
      setTaskFields(a!.id, { branchName: "feature/a" });
      updateTaskStatus(a!.id, "done");
      expect(hasActiveBranchBoundTasksForProject("proj-1")).toBe(false);
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

  describe("runtime warmup sessions", () => {
    const scope = {
      projectId: "proj-1",
      runtimeProfileId: "profile-1",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      model: "claude-sonnet-4",
    };

    it("finds the active ready warmup for a runtime scope", () => {
      const row = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 600,
        expiresAt: "2026-04-30T12:10:00.000Z",
      });
      expect(row).toBeDefined();
      expect(findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:00:00.000Z")).toBeUndefined();

      markRuntimeWarmupSessionReady(row!.id, {
        sourceSessionId: "seed-session-1",
        summary: "Seeded plan context",
        updatedAt: "2026-04-30T12:01:00.000Z",
      });

      const found = findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:02:00.000Z");
      expect(found).toEqual(
        expect.objectContaining({
          id: row!.id,
          status: "ready",
          sourceSessionId: "seed-session-1",
          summary: "Seeded plan context",
        }),
      );
    });

    it("expires stale active warmups and excludes expired rows from lookup", () => {
      const row = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 60,
        expiresAt: "2026-04-30T12:00:00.000Z",
      })!;
      markRuntimeWarmupSessionReady(row.id, {
        sourceSessionId: "seed-expired",
        updatedAt: "2026-04-30T11:59:00.000Z",
      });

      expect(findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:00:00.000Z")).toBeUndefined();
      expect(expireStaleRuntimeWarmupSessions("2026-04-30T12:00:00.000Z")).toBe(1);
      expect(expireStaleRuntimeWarmupSessions("2026-04-30T12:00:00.000Z")).toBe(0);
      expect(findRuntimeWarmupSessionById(row.id)?.status).toBe("expired");
    });

    it("preserves an existing ready warmup until a replacement becomes ready", () => {
      const first = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 600,
        expiresAt: "2026-04-30T13:00:00.000Z",
        createdAt: "2026-04-30T12:00:00.000Z",
      })!;
      markRuntimeWarmupSessionReady(first.id, {
        sourceSessionId: "seed-old",
        updatedAt: "2026-04-30T12:01:00.000Z",
      });

      const second = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 600,
        expiresAt: "2026-04-30T13:10:00.000Z",
        createdAt: "2026-04-30T12:10:00.000Z",
      })!;

      expect(findRuntimeWarmupSessionById(first.id)?.status).toBe("ready");
      expect(second.status).toBe("creating");
      expect(findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:11:00.000Z")?.id).toBe(
        first.id,
      );

      markRuntimeWarmupSessionReady(second.id, {
        sourceSessionId: "seed-new",
        updatedAt: "2026-04-30T12:12:00.000Z",
      });
      expect(findRuntimeWarmupSessionById(first.id)?.status).toBe("cleared");
      expect(findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:13:00.000Z")?.id).toBe(
        second.id,
      );
    });

    it("does not resurrect a cleared pending warmup when it finishes late", () => {
      const first = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 600,
        expiresAt: "2026-04-30T13:00:00.000Z",
        createdAt: "2026-04-30T12:00:00.000Z",
      })!;
      const second = createRuntimeWarmupSession({
        ...scope,
        ttlSeconds: 600,
        expiresAt: "2026-04-30T13:05:00.000Z",
        createdAt: "2026-04-30T12:01:00.000Z",
      })!;

      markRuntimeWarmupSessionReady(second.id, {
        sourceSessionId: "seed-second",
        updatedAt: "2026-04-30T12:02:00.000Z",
      });
      expect(findRuntimeWarmupSessionById(first.id)?.status).toBe("cleared");

      const stale = markRuntimeWarmupSessionReady(first.id, {
        sourceSessionId: "seed-first-late",
        updatedAt: "2026-04-30T12:03:00.000Z",
      });

      expect(stale).toEqual(
        expect.objectContaining({
          id: first.id,
          status: "cleared",
          sourceSessionId: null,
        }),
      );
      expect(findActiveReadyRuntimeWarmupSession(scope, "2026-04-30T12:04:00.000Z")?.id).toBe(
        second.id,
      );
    });

    it("persists failed warmups without making them active", () => {
      const row = createRuntimeWarmupSession({
        ...scope,
        model: "claude-opus-4",
        ttlSeconds: 600,
        expiresAt: "2026-04-30T13:00:00.000Z",
      })!;

      const failed = markRuntimeWarmupSessionFailed(
        row.id,
        "Runtime did not return a seed session",
        "2026-04-30T12:05:00.000Z",
      );

      expect(failed).toEqual(
        expect.objectContaining({
          status: "failed",
          errorMessage: "Runtime did not return a seed session",
        }),
      );
      expect(
        findActiveReadyRuntimeWarmupSession(
          { ...scope, model: "claude-opus-4" },
          "2026-04-30T12:06:00.000Z",
        ),
      ).toBeUndefined();
    });

    it("returns empty results for missing warmup updates and clears", () => {
      expect(
        markRuntimeWarmupSessionReady("missing-warmup", {
          sourceSessionId: "seed-missing",
        }),
      ).toBeUndefined();
      expect(markRuntimeWarmupSessionFailed("missing-warmup", "failed")).toBeUndefined();
      expect(clearActiveRuntimeWarmupSessions({ ...scope, model: "missing-model" })).toBe(0);
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
