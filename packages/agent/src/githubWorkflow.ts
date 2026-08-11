import { execFileSync } from "node:child_process";
import {
  appendTaskActivityLog,
  findGitHubIssueByTaskId,
  findTaskById,
  listEnabledGitHubRepositories,
} from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import { internalApiHeaders } from "./notifier.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("github-workflow");
const SYNC_INTERVAL_MS = 60_000;
const lastSyncAttempts = new Map<string, number>();

interface GitHubApiFailure {
  error?: string;
  code?: string;
  retryAt?: string | null;
}

async function readFailure(response: Response): Promise<GitHubApiFailure> {
  try {
    return (await response.json()) as GitHubApiFailure;
  } catch {
    return {};
  }
}

export async function synchronizeGitHubProjects(now = Date.now()): Promise<void> {
  const env = getEnv();
  if (!env.AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug("GitHub synchronization skipped because rollout flag is disabled");
    return;
  }
  const baseUrl = env.API_BASE_URL;
  for (const connection of listEnabledGitHubRepositories()) {
    const lastSync = connection.lastSyncedAt ? Date.parse(connection.lastSyncedAt) : 0;
    const lastAttempt = lastSyncAttempts.get(connection.projectId) ?? 0;
    if (
      (Number.isFinite(lastSync) && now - lastSync < SYNC_INTERVAL_MS) ||
      now - lastAttempt < SYNC_INTERVAL_MS
    ) {
      continue;
    }
    lastSyncAttempts.set(connection.projectId, now);

    const url = `${baseUrl}/projects/${connection.projectId}/github/sync`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: internalApiHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const failure = await readFailure(response);
        log.warn(
          {
            projectId: connection.projectId,
            status: response.status,
            code: failure.code ?? "github_sync_failed",
            retryAt: failure.retryAt ?? null,
          },
          "GitHub repository sync deferred",
        );
      }
    } catch (error) {
      log.warn({ projectId: connection.projectId, error }, "GitHub repository sync unavailable");
    }
  }
}

function pushBranch(projectRoot: string, branch: string): void {
  execFileSync("git", ["push", "--set-upstream", "origin", branch], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function publishGitHubTask(taskId: string, projectRoot: string): Promise<boolean> {
  if (!getEnv().AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      { taskId },
      "GitHub pull request publication skipped because rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitHubIssueByTaskId(taskId);
  if (!issue) return false;

  const task = findTaskById(taskId);
  if (!task?.branchName) {
    throw new StageManualBlockError("GitHub pull request publication requires a task branch.");
  }
  const executionRoot = task.worktreePath ?? projectRoot;
  const commit = await ensureAutoQueueTaskCommit({ taskId, projectRoot: executionRoot });

  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, error }, "GitHub task branch push failed");
    throw new StageManualBlockError(
      "GitHub branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  const refreshed = findTaskById(taskId);
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/github/tasks/${taskId}/publish`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({
        branch: task.branchName,
        commitSha: commit.commitSha,
        implementationLog: refreshed?.implementationLog ?? null,
        reviewComments: refreshed?.reviewComments ?? null,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    log.error({ taskId, branch: task.branchName, error }, "GitHub pull request API unavailable");
    throw new StageManualBlockError(
      "GitHub pull request publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "github_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitHub pull request publication failed",
    );
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitHub rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitHub pull request publication failed. Check repository permissions and retry.",
    );
  }

  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [github] Published ${task.branchName} for issue #${issue.issueNumber}`,
  );
  log.info(
    { taskId, issueNumber: issue.issueNumber, branch: task.branchName },
    "GitHub pull request synchronized",
  );
  return true;
}
