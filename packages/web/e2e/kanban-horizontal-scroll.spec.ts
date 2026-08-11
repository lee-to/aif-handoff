import { expect, test } from "@playwright/test";

const PROJECT_ID = "00000000-0000-4000-8000-000000000151";

function makeTask(index: number) {
  return {
    id: `scroll-task-${index}`,
    projectId: PROJECT_ID,
    title: `Horizontal wheel target ${index}`,
    description: "Horizontal gestures should reach the board",
    autoMode: true,
    executionOwner: "ai",
    ownershipRevision: 0,
    assignees: [],
    isFix: false,
    status: "backlog",
    priority: 1,
    position: index * 1000,
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
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    manualReviewRequired: false,
    paused: false,
    lastSyncedAt: null,
    runtimeProfileId: null,
    modelOverride: null,
    runtimeLimitSnapshot: null,
    runtimeLimitUpdatedAt: null,
    scheduledAt: null,
    hasPlan: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("horizontal wheel gestures over a card list scroll the kanban board", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/projects",
    async (route) => {
      await route.fulfill({
        json: [
          {
            id: PROJECT_ID,
            name: "Scroll regression project",
            rootPath: "/tmp/scroll-regression",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/tasks" && url.searchParams.get("projectId") === PROJECT_ID,
    async (route) => {
      await route.fulfill({
        json: Array.from({ length: 12 }, (_, index) => makeTask(index + 1)),
      });
    },
  );
  await page.route("**/settings", async (route) => {
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
  });
  await page.route("**/runtime-profiles/effective/chat/*", async (route) => {
    await route.fulfill({ json: { profile: null, resolved: null } });
  });

  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto(`/project/${PROJECT_ID}`);

  const board = page.getByTestId("kanban-board");
  const card = page.getByText("Horizontal wheel target 1", { exact: true });
  const cardList = card.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' overflow-y-auto ')][1]",
  );

  await expect(board).toBeVisible();
  await expect(card).toBeVisible();
  await expect
    .poll(() => board.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await expect
    .poll(() => cardList.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBe(0);

  await card.hover();
  await page.mouse.wheel(400, 0);

  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});
