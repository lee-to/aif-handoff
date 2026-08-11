import { expect, test } from "@playwright/test";

const PROJECT_ID = "00000000-0000-4000-8000-000000000159";
const PARTICIPANT_ID = "00000000-0000-4000-8000-000000000001";

const participant = {
  id: PARTICIPANT_ID,
  username: "admin",
  displayName: "Ada Admin",
  role: "admin",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const authenticatedSession = {
  participantsModeEnabled: true,
  authenticated: true,
  participant,
  csrfToken: "synthetic-csrf-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function makeTask() {
  return {
    id: "participants-task-1",
    projectId: PROJECT_ID,
    title: "Participants collaboration flow",
    description: "Exercise ownership without a persistent database.",
    attachments: [],
    autoMode: false,
    executionOwner: "ai",
    ownershipRevision: 0,
    assignees: [],
    permissions: {
      canAssign: true,
      canHandoff: true,
      canSelfAssign: true,
      canAct: false,
      canComment: true,
      permittedActions: [],
    },
    isFix: false,
    plannerMode: "full",
    planPath: ".ai-factory/PLAN.md",
    planDocs: false,
    planTests: false,
    skipReview: false,
    useSubagents: true,
    runPlanImprove: false,
    runPostVerify: false,
    autoQa: false,
    qaStatus: "idle",
    qaChangeSummary: null,
    qaTestPlan: null,
    qaTestCases: null,
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    manualReviewRequired: false,
    autoReviewState: null,
    paused: false,
    status: "implementing",
    priority: 1,
    position: 1000,
    plan: null,
    implementationLog: null,
    reviewComments: null,
    agentActivityLog: null,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    tokenInput: 0,
    tokenOutput: 0,
    tokenTotal: 0,
    costUsd: 0,
    roadmapAlias: null,
    tags: [],
    lastHeartbeatAt: null,
    lastSyncedAt: null,
    sessionId: null,
    scheduledAt: null,
    branchName: null,
    worktreePath: null,
    runtimeProfileId: null,
    modelOverride: null,
    runtimeLimitSnapshot: null,
    runtimeLimitUpdatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("logs in, hands off a task, filters it, and reads immutable executor history", async ({
  page,
}) => {
  let task = makeTask();
  let authenticated = false;
  const history = [
    {
      id: "history-1",
      taskId: task.id,
      taskTitleSnapshot: task.title,
      ownershipRevision: 0,
      executionOwner: "ai",
      assignees: [],
      statusSnapshot: "implementing",
      actor: { kind: "system", id: null, displayNameSnapshot: "System" },
      reason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");

    if (path === "/auth/session") {
      await route.fulfill({
        json: authenticated
          ? authenticatedSession
          : {
              participantsModeEnabled: true,
              authenticated: false,
              participant: null,
              csrfToken: null,
              expiresAt: null,
            },
      });
      return;
    }
    if (path === "/auth/login" && request.method() === "POST") {
      authenticated = true;
      await route.fulfill({ json: authenticatedSession });
      return;
    }
    if (path === "/projects") {
      await route.fulfill({
        json: [
          {
            id: PROJECT_ID,
            name: "Participants E2E",
            rootPath: "/tmp/participants-e2e",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (path === "/tasks" && request.method() === "GET") {
      await route.fulfill({ json: [task] });
      return;
    }
    if (path === `/tasks/${task.id}` && request.method() === "GET") {
      await route.fulfill({ json: task });
      return;
    }
    if (path === `/tasks/${task.id}/handoff` && request.method() === "POST") {
      const input = request.postDataJSON() as {
        executionOwner: "ai" | "human";
        assigneeIds: string[];
      };
      task = {
        ...task,
        executionOwner: input.executionOwner,
        ownershipRevision: task.ownershipRevision + 1,
        assignees: input.assigneeIds.includes(PARTICIPANT_ID)
          ? [
              {
                participantId: PARTICIPANT_ID,
                displayName: participant.displayName,
                role: participant.role,
                active: true,
              },
            ]
          : [],
      };
      const historyEntry = {
        id: "history-2",
        taskId: task.id,
        taskTitleSnapshot: task.title,
        ownershipRevision: task.ownershipRevision,
        executionOwner: task.executionOwner,
        assignees: task.assignees,
        statusSnapshot: "implementing",
        actor: {
          kind: "participant",
          id: PARTICIPANT_ID,
          displayNameSnapshot: participant.displayName,
        },
        reason: "E2E handoff",
        createdAt: "2026-01-01T00:01:00.000Z",
      };
      history.push(historyEntry);
      await route.fulfill({
        json: {
          task,
          ownership: {
            executionOwner: task.executionOwner,
            ownershipRevision: task.ownershipRevision,
            assignees: task.assignees,
          },
          history: historyEntry,
        },
      });
      return;
    }
    if (path === `/tasks/${task.id}/executor-history`) {
      await route.fulfill({ json: history });
      return;
    }
    if (path === "/participants") {
      await route.fulfill({ json: [participant] });
      return;
    }
    if (path === "/settings") {
      await route.fulfill({
        json: {
          useSubagents: false,
          maxReviewIterations: 3,
          autoReviewStrategy: "full_re_review",
          usageLimitsEnabled: false,
          warmupEnabled: false,
          qaPipelineEnabled: false,
          runtimeReadiness: {
            availableRuntimeCount: 0,
            runtimeProfileCount: 0,
            enabledRuntimeProfileCount: 0,
          },
          runtimeDefaults: {
            modules: [],
            openAiBaseUrlConfigured: false,
            codexCliPathConfigured: false,
            app: {},
          },
        },
      });
      return;
    }
    if (path.startsWith("/runtime-profiles/effective/")) {
      await route.fulfill({ json: { profile: null, resolved: null } });
      return;
    }

    await route.fallback();
  });

  await page.goto(`/project/${PROJECT_ID}`);
  await expect(page.getByRole("heading", { name: "Sign in to AI Factory" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByText(task.title, { exact: true }).click();
  await page.getByRole("button", { name: "Assign / hand off" }).click();
  await page.getByText("Human", { exact: true }).click();
  await page.getByRole("checkbox", { name: /Ada Admin/ }).click();
  await page.getByLabel("Reason (optional)").fill("E2E handoff");
  await page.getByRole("button", { name: "Save ownership" }).click();
  await expect(page.getByText("Human owner").first()).toBeVisible();

  await page.getByRole("tab", { name: "Executors" }).click();
  await expect(page.getByText("E2E handoff")).toBeVisible();
  await expect(page.getByText("Ada Admin").first()).toBeVisible();

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "AI-owned" }).click();
  await expect(page.getByText(task.title, { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "clear filters" }).click();
  await page.getByRole("button", { name: "human-owned" }).click();
  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
});
