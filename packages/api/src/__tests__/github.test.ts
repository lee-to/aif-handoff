import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { projects, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const { githubRouter } = await import("../routes/github.js");
const { GitHubClient, issueIsEligible } = await import("../services/github.js");
const { deleteTask, findGitHubIssue, findTaskById, importGitHubIssueTask, upsertGitHubRepository } =
  await import("@aif/data");

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project-1", name: "Repo", rootPath: "/tmp/repo" })
    .run();
  vi.stubEnv("GITHUB_TEST_TOKEN", "secret-token");
  vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
  resetEnvCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("GitHub client", () => {
  it("classifies rate limits from structured HTTP fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: "limit" },
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "2000000000",
            },
          },
        ),
      ),
    );

    await expect(new GitHubClient("secret").getRepository("owner", "repo")).rejects.toMatchObject({
      httpStatus: 403,
      adapterCode: "rate_limited",
    });
  });

  it("applies label, assignee, and milestone eligibility", () => {
    expect(
      issueIsEligible(
        {
          number: 1,
          node_id: "I_1",
          html_url: "https://github.com/o/r/issues/1",
          state: "open",
          title: "Task",
          body: "",
          user: { login: "author" },
          labels: [{ name: "aif" }],
          assignees: [{ login: "bot" }],
          milestone: { title: "v1" },
          comments: 0,
          updated_at: "2026-08-08T00:00:00Z",
        },
        { labels: ["aif"], assignee: "bot", milestone: "v1" },
      ),
    ).toBe(true);
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
  ] as const)(
    "uses an Actions-only %s check run when legacy statuses are absent",
    async (conclusion, expected) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ state: "pending", total_count: 0, statuses: [] }))
        .mockResolvedValueOnce(
          jsonResponse({
            total_count: 1,
            check_runs: [{ status: "completed", conclusion }],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new GitHubClient("secret").getCommitChecks("owner", "repo", "abc"),
      ).resolves.toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe("GitHub project routes", () => {
  it("rejects GitHub routes while the rollout flag is disabled", async () => {
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "false");
    resetEnvCache();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);

    const response = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "owner/repo", tokenEnvVar: "GITHUB_TEST_TOKEN" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "feature_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects a repository and performs an idempotent empty sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          name: "repo",
          full_name: "owner/repo",
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          owner: { login: "owner" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);

    const connected = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: "owner/repo",
        tokenEnvVar: "GITHUB_TEST_TOKEN",
        enabled: true,
        eligibility: { labels: ["aif"], assignee: null, milestone: null },
      }),
    });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      owner: "owner",
      name: "repo",
      tokenConfigured: true,
    });

    const synced = await app.request("/projects/project-1/github/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ imported: 0, updated: 0, skipped: 0 });
  });

  it("rejects a connection when its credential environment variable is absent", async () => {
    vi.stubEnv("GITHUB_MISSING_TOKEN", "");
    const app = new Hono();
    app.route("/projects", githubRouter);
    const response = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "owner/repo", tokenEnvVar: "GITHUB_MISSING_TOKEN" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "github_authentication" });
  });

  it.each([
    {
      caseName: "has no requested changes",
      reviews: [],
      expectedStatus: "done",
      expectedReviewState: "pending",
    },
    {
      caseName: "already has requested changes",
      reviews: [
        {
          id: 301,
          state: "CHANGES_REQUESTED",
          body: "Please address this finding",
          submitted_at: "2026-08-08T01:00:00Z",
        },
      ],
      expectedStatus: "implementing",
      expectedReviewState: "changes_requested",
    },
  ] as const)(
    "imports an issue with a closing pull request when it $caseName",
    async ({ reviews, expectedStatus, expectedReviewState }) => {
      upsertGitHubRepository({
        projectId: "project-1",
        owner: "owner",
        name: "repo",
        htmlUrl: "https://github.com/owner/repo",
        defaultBranch: "main",
        tokenEnvVar: "GITHUB_TEST_TOKEN",
        eligibility: { labels: [], assignee: null, milestone: null },
        enabled: true,
      });
      const pull = {
        number: 200,
        html_url: "https://github.com/owner/repo/pull/200",
        state: "open",
        merged_at: null,
        body: "Closes #154",
        head: { sha: "0123456789abcdef" },
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse([
              {
                number: 154,
                node_id: "I_154",
                html_url: "https://github.com/owner/repo/issues/154",
                state: "open",
                title: "GitHub mode",
                body: "Implement it",
                user: { login: "author" },
                labels: [],
                assignees: [],
                milestone: null,
                comments: 0,
                updated_at: "2026-08-08T00:00:00Z",
              },
            ]),
          )
          .mockResolvedValueOnce(jsonResponse([pull]))
          .mockResolvedValueOnce(jsonResponse(reviews))
          .mockResolvedValueOnce(jsonResponse({ state: "success", total_count: 1, statuses: [{}] }))
          .mockResolvedValueOnce(jsonResponse({ total_count: 0, check_runs: [] })),
      );
      const app = new Hono();
      app.route("/projects", githubRouter);

      const response = await app.request("/projects/project-1/github/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as { issues: Array<{ taskId: string }> };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
      expect(findTaskById(body.issues[0]!.taskId)?.status).toBe(expectedStatus);
      expect(findGitHubIssue("project-1", 154)).toMatchObject({
        prNumber: 200,
        prUrl: pull.html_url,
        prState: "open",
        reviewState: expectedReviewState,
      });
    },
  );

  it("skips closed orphaned issues and links pull requests to existing tasks", async () => {
    upsertGitHubRepository({
      projectId: "project-1",
      owner: "owner",
      name: "repo",
      htmlUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITHUB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const closed = importGitHubIssueTask({
      projectId: "project-1",
      owner: "owner",
      repository: "repo",
      issueNumber: 168,
      nodeId: "I_168",
      htmlUrl: "https://github.com/owner/repo/issues/168",
      state: "open",
      sourceUpdatedAt: "2026-08-07T00:00:00Z",
      snapshot: {
        title: "Already completed",
        body: "Done elsewhere",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const open = importGitHubIssueTask({
      projectId: "project-1",
      owner: "owner",
      repository: "repo",
      issueNumber: 154,
      nodeId: "I_154",
      htmlUrl: "https://github.com/owner/repo/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-07T00:00:00Z",
      snapshot: {
        title: "GitHub mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    deleteTask(closed.taskId);

    const pull = {
      number: 200,
      html_url: "https://github.com/owner/repo/pull/200",
      state: "open",
      merged_at: null,
      body: "Closes #154",
      head: { sha: "0123456789abcdef" },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([
            {
              number: 168,
              node_id: "I_168",
              html_url: "https://github.com/owner/repo/issues/168",
              state: "closed",
              title: "Already completed",
              body: "Done elsewhere",
              user: { login: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              comments: 0,
              updated_at: "2026-08-08T00:00:00Z",
            },
            {
              number: 154,
              node_id: "I_154",
              html_url: "https://github.com/owner/repo/issues/154",
              state: "open",
              title: "GitHub mode",
              body: "Implement it",
              user: { login: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              comments: 0,
              updated_at: "2026-08-08T00:00:00Z",
            },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse([pull]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ state: "success", total_count: 1, statuses: [{}] }))
        .mockResolvedValueOnce(jsonResponse({ total_count: 0, check_runs: [] })),
    );
    const app = new Hono();
    app.route("/projects", githubRouter);

    const response = await app.request("/projects/project-1/github/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: 0, updated: 1, skipped: 1 });
    expect(findGitHubIssue("project-1", 168)?.taskId).toBeNull();
    expect(findTaskById(closed.taskId)).toBeUndefined();
    const linked = findGitHubIssue("project-1", 154);
    expect(linked).toMatchObject({ prNumber: 200, prState: "open" });
    expect(linked?.taskId).toBe(open.taskId);
    expect(findTaskById(open.taskId)?.status).toBe("done");
  });

  it("creates one pull request and reuses it on repeated publication", async () => {
    upsertGitHubRepository({
      projectId: "project-1",
      owner: "owner",
      name: "repo",
      htmlUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITHUB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const imported = importGitHubIssueTask({
      projectId: "project-1",
      owner: "owner",
      repository: "repo",
      issueNumber: 154,
      nodeId: "I_154",
      htmlUrl: "https://github.com/owner/repo/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-08T00:00:00Z",
      snapshot: {
        title: "GitHub mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const pull = {
      number: 200,
      html_url: "https://github.com/owner/repo/pull/200",
      state: "open",
      merged_at: null,
      head: { sha: "0123456789abcdef" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ state: "success", total_count: 1, statuses: [{}] }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 0, check_runs: [] }))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse({ state: "success", total_count: 1, statuses: [{}] }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 0, check_runs: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);
    const publish = () =>
      app.request(`/projects/project-1/github/tasks/${imported.taskId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: "feature/github-issue-154",
          commitSha: "0123456789abcdef",
          implementationLog: "Implemented",
          reviewComments: "Automated review passed",
        }),
      });

    expect(await (await publish()).json()).toMatchObject({ prNumber: 200, prState: "open" });
    expect(await (await publish()).json()).toMatchObject({ prNumber: 200, prState: "open" });
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/pulls") && init?.method === "POST",
    );
    const commentCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/issues/200/comments") && init?.method === "POST",
    );
    expect(createCalls).toHaveLength(1);
    expect(commentCalls).toHaveLength(1);
  });
});
