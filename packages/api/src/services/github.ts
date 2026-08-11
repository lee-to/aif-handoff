import { createHash } from "node:crypto";
import { logger, type GitHubEligibility, type GitHubIssueSnapshot } from "@aif/shared";

const log = logger("github-api");
const API_BASE = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly adapterCode:
      | "authentication"
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "validation"
      | "upstream",
    readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubRepositoryResponse {
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  owner: { login: string };
}

interface GitHubIssueResponse {
  number: number;
  node_id: string;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: Array<{ name?: string } | string>;
  assignees: Array<{ login: string }>;
  milestone: { title: string } | null;
  comments: number;
  updated_at: string;
  pull_request?: unknown;
}

interface GitHubCommentResponse {
  id: number;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubPullResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  body: string | null;
  head: { sha: string };
}

interface GitHubReviewResponse {
  id: number;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

type GitHubCheckState = "pending" | "success" | "failure" | null;

interface GitHubCombinedStatusResponse {
  state: "pending" | "success" | "failure" | "error";
  total_count?: number;
  statuses?: unknown[];
}

interface GitHubCheckRunResponse {
  status: string;
  conclusion: string | null;
}

interface GitHubCheckRunsResponse {
  total_count: number;
  check_runs: GitHubCheckRunResponse[];
}

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function retryAtFromHeaders(headers: Headers): string | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1000).toISOString()
    : null;
}

function classifyHttpError(status: number, headers: Headers): GitHubApiError["adapterCode"] {
  if (status === 401) return "authentication";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) {
    return "rate_limited";
  }
  if (status === 403) return "forbidden";
  return "upstream";
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    log.debug({ method, path }, "GitHub API request started");
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const code = classifyHttpError(response.status, response.headers);
      const message = typeof payload?.message === "string" ? payload.message : response.statusText;
      log.warn(
        { method, path, status: response.status, adapterCode: code },
        "GitHub API request failed",
      );
      throw new GitHubApiError(
        `GitHub API ${response.status}: ${message}`,
        response.status,
        code,
        code === "rate_limited" ? retryAtFromHeaders(response.headers) : null,
      );
    }
    log.debug({ method, path, status: response.status }, "GitHub API request completed");
    return (await response.json()) as T;
  }

  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pageItems = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      items.push(...pageItems);
      if (pageItems.length < 100) return items;
    }
  }

  getRepository(owner: string, repository: string): Promise<GitHubRepositoryResponse> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`);
  }

  async listIssues(owner: string, repository: string): Promise<GitHubIssueResponse[]> {
    const rows = await this.list<GitHubIssueResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues?state=all&sort=updated&direction=desc`,
    );
    return rows.filter((row) => row.pull_request === undefined);
  }

  listIssueComments(
    owner: string,
    repository: string,
    issueNumber: number,
  ): Promise<GitHubCommentResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/comments`,
    );
  }

  getPullRequest(owner: string, repository: string, prNumber: number): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${prNumber}`,
    );
  }

  async findPullRequest(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<GitHubPullResponse | null> {
    const pulls = await this.list<GitHubPullResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return pulls[0] ?? null;
  }

  listOpenPullRequests(owner: string, repository: string): Promise<GitHubPullResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=open`,
    );
  }

  createPullRequest(input: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: false,
        }),
      },
    );
  }

  updatePullRequest(input: {
    owner: string;
    repository: string;
    prNumber: number;
    title: string;
    body: string;
  }): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.prNumber}`,
      { method: "PATCH", body: JSON.stringify({ title: input.title, body: input.body }) },
    );
  }

  listReviews(
    owner: string,
    repository: string,
    prNumber: number,
  ): Promise<GitHubReviewResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${prNumber}/reviews`,
    );
  }

  private async listCheckRuns(
    owner: string,
    repository: string,
    sha: string,
  ): Promise<GitHubCheckRunResponse[]> {
    const runs: GitHubCheckRunResponse[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<GitHubCheckRunsResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      runs.push(...response.check_runs);
      if (response.check_runs.length < 100 || runs.length >= response.total_count) return runs;
    }
  }

  async getCommitChecks(owner: string, repository: string, sha: string): Promise<GitHubCheckState> {
    const [status, checkRuns] = await Promise.all([
      this.request<GitHubCombinedStatusResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}/status`,
      ),
      this.listCheckRuns(owner, repository, sha),
    ]);
    const states: Exclude<GitHubCheckState, null>[] = [];
    const legacyCount = status.total_count ?? status.statuses?.length;
    if (legacyCount === undefined || legacyCount > 0) {
      states.push(status.state === "error" ? "failure" : status.state);
    }
    for (const run of checkRuns) {
      if (run.status !== "completed") {
        states.push("pending");
      } else {
        states.push(
          run.conclusion && SUCCESSFUL_CHECK_CONCLUSIONS.has(run.conclusion)
            ? "success"
            : "failure",
        );
      }
    }
    const result: GitHubCheckState = states.includes("failure")
      ? "failure"
      : states.includes("pending")
        ? "pending"
        : states.includes("success")
          ? "success"
          : null;
    log.debug(
      {
        owner,
        repository,
        sha,
        legacyCount: legacyCount ?? null,
        checkRunCount: checkRuns.length,
        result,
      },
      "Combined GitHub commit statuses and check runs",
    );
    return result;
  }

  async upsertMarkerComment(input: {
    owner: string;
    repository: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<void> {
    const comments = await this.listIssueComments(input.owner, input.repository, input.issueNumber);
    const existing = comments.find((comment) => comment.body?.includes(input.marker));
    const body = `${input.marker}\n${input.body}`;
    if (existing) {
      await this.request(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ body }),
        },
      );
      return;
    }
    await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }
}

export function issueIsEligible(
  issue: GitHubIssueResponse,
  eligibility: GitHubEligibility,
): boolean {
  const labels = issue.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
  const hasLabels = eligibility.labels.every((required) => labels.includes(required));
  const hasAssignee = eligibility.assignee
    ? issue.assignees.some((assignee) => assignee.login === eligibility.assignee)
    : true;
  const hasMilestone = eligibility.milestone
    ? issue.milestone?.title === eligibility.milestone
    : true;
  return issue.state === "open" && hasLabels && hasAssignee && hasMilestone;
}

export function findPullRequestClosingIssue(
  pulls: GitHubPullResponse[],
  issueNumber: number,
): GitHubPullResponse | null {
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${issueNumber}(?!\\d)`,
    "i",
  );
  return pulls.find((pull) => pull.body && closingReference.test(pull.body)) ?? null;
}

export async function toIssueSnapshot(
  client: GitHubClient,
  owner: string,
  repository: string,
  issue: GitHubIssueResponse,
): Promise<GitHubIssueSnapshot> {
  const comments =
    issue.comments > 0 ? await client.listIssueComments(owner, repository, issue.number) : [];
  return {
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "unknown",
    labels: issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    assignees: issue.assignees.map((assignee) => assignee.login),
    milestone: issue.milestone?.title ?? null,
    comments: comments.slice(-100).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      htmlUrl: comment.html_url,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
  };
}

export function reviewFingerprint(reviewComments: string): string {
  return createHash("sha256").update(reviewComments).digest("hex");
}

export function latestReviewState(reviews: GitHubReviewResponse[]): {
  id: number | null;
  state: "pending" | "approved" | "changes_requested";
  body: string | null;
} {
  const latest = [...reviews]
    .filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
    .sort((left, right) => (right.submitted_at ?? "").localeCompare(left.submitted_at ?? ""))[0];
  if (!latest) return { id: null, state: "pending", body: null };
  return {
    id: latest.id,
    state: latest.state === "APPROVED" ? "approved" : "changes_requested",
    body: latest.body,
  };
}
