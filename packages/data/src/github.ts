import { and, desc, eq, max } from "drizzle-orm";
import {
  auditEvents,
  generatePlanPath,
  getProjectConfig,
  githubIssues,
  githubRepositories,
  logger,
  projects,
  taskExecutorHistory,
  tasks,
  type GitHubEligibility,
  type GitHubIssueLink,
  type GitHubIssueRow,
  type GitHubIssueSnapshot,
  type GitHubRepositoryConnection,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

const log = logger("data:github");
const DEFAULT_ELIGIBILITY: GitHubEligibility = { labels: [], assignee: null, milestone: null };

function parseEligibility(raw: string): GitHubEligibility {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ELIGIBILITY;
    const record = value as Record<string, unknown>;
    return {
      labels: Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === "string")
        : [],
      assignee: typeof record.assignee === "string" ? record.assignee : null,
      milestone: typeof record.milestone === "string" ? record.milestone : null,
    };
  } catch {
    return DEFAULT_ELIGIBILITY;
  }
}

function parseIssueSnapshot(raw: string): GitHubIssueSnapshot {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      author: typeof record.author === "string" ? record.author : "unknown",
      labels: Array.isArray(record.labels)
        ? record.labels.filter((item): item is string => typeof item === "string")
        : [],
      assignees: Array.isArray(record.assignees)
        ? record.assignees.filter((item): item is string => typeof item === "string")
        : [],
      milestone: typeof record.milestone === "string" ? record.milestone : null,
      comments: Array.isArray(record.comments)
        ? record.comments.filter(
            (item): item is GitHubIssueSnapshot["comments"][number] =>
              Boolean(item) &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).id === "number" &&
              typeof (item as Record<string, unknown>).author === "string" &&
              typeof (item as Record<string, unknown>).body === "string" &&
              typeof (item as Record<string, unknown>).htmlUrl === "string" &&
              typeof (item as Record<string, unknown>).createdAt === "string" &&
              typeof (item as Record<string, unknown>).updatedAt === "string",
          )
        : [],
    };
  } catch {
    return { title: "", body: "", author: "unknown", labels: [], assignees: [], milestone: null, comments: [] };
  }
}

function toIssueLink(row: GitHubIssueRow): GitHubIssueLink {
  return {
    projectId: row.projectId,
    issueNumber: row.issueNumber,
    taskId: row.taskId,
    nodeId: row.nodeId,
    htmlUrl: row.htmlUrl,
    state: row.state,
    metadata: parseIssueSnapshot(row.metadataJson),
    sourceUpdatedAt: row.sourceUpdatedAt,
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prState: row.prState,
    prChecksStatus: row.prChecksStatus,
    reviewState: row.reviewState,
    lastReviewId: row.lastReviewId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConnection(row: typeof githubRepositories.$inferSelect): GitHubRepositoryConnection {
  return {
    projectId: row.projectId,
    owner: row.owner,
    name: row.name,
    htmlUrl: row.htmlUrl,
    defaultBranch: row.defaultBranch,
    tokenEnvVar: row.tokenEnvVar,
    eligibility: parseEligibility(row.eligibilityJson),
    enabled: row.enabled,
    tokenConfigured: Boolean(process.env[row.tokenEnvVar]?.trim()),
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findGitHubRepository(projectId: string): GitHubRepositoryConnection | undefined {
  const row = getDb()
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.projectId, projectId))
    .get();
  return row ? toConnection(row) : undefined;
}

export function listEnabledGitHubRepositories(): GitHubRepositoryConnection[] {
  return getDb()
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.enabled, true))
    .all()
    .map(toConnection);
}

export function upsertGitHubRepository(input: {
  projectId: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitHubEligibility;
  enabled: boolean;
}): GitHubRepositoryConnection {
  const now = new Date().toISOString();
  getDb()
    .insert(githubRepositories)
    .values({
      ...input,
      eligibilityJson: JSON.stringify(input.eligibility),
      syncError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: githubRepositories.projectId,
      set: {
        owner: input.owner,
        name: input.name,
        htmlUrl: input.htmlUrl,
        defaultBranch: input.defaultBranch,
        tokenEnvVar: input.tokenEnvVar,
        eligibilityJson: JSON.stringify(input.eligibility),
        enabled: input.enabled,
        syncError: null,
        updatedAt: now,
      },
    })
    .run();
  log.info({ projectId: input.projectId, repository: `${input.owner}/${input.name}` }, "GitHub repository connection saved");
  return findGitHubRepository(input.projectId)!;
}

export function deleteGitHubRepository(projectId: string): boolean {
  const result = getDb()
    .delete(githubRepositories)
    .where(eq(githubRepositories.projectId, projectId))
    .run();
  log.info({ projectId, deleted: result.changes > 0 }, "GitHub repository connection removed");
  return result.changes > 0;
}

export function recordGitHubRepositorySync(projectId: string, error: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .update(githubRepositories)
    .set({ lastSyncedAt: now, syncError: error, updatedAt: now })
    .where(eq(githubRepositories.projectId, projectId))
    .run();
}

function renderIssueDescription(input: {
  issueNumber: number;
  htmlUrl: string;
  snapshot: GitHubIssueSnapshot;
}): string {
  const { snapshot } = input;
  const context = [
    `Source: ${input.htmlUrl}`,
    `Author: @${snapshot.author}`,
    snapshot.labels.length > 0 ? `Labels: ${snapshot.labels.join(", ")}` : null,
    snapshot.assignees.length > 0 ? `Assignees: ${snapshot.assignees.map((name) => `@${name}`).join(", ")}` : null,
    snapshot.milestone ? `Milestone: ${snapshot.milestone}` : null,
  ].filter(Boolean);
  const comments = snapshot.comments.map(
    (comment) => `### @${comment.author} — ${comment.createdAt}\n\n${comment.body}\n\n${comment.htmlUrl}`,
  );
  return [context.join("\n"), snapshot.body, comments.length > 0 ? `## GitHub comments\n\n${comments.join("\n\n")}` : null]
    .filter(Boolean)
    .join("\n\n");
}

export interface ImportGitHubIssueInput {
  projectId: string;
  owner: string;
  repository: string;
  issueNumber: number;
  nodeId: string;
  htmlUrl: string;
  state: "open" | "closed";
  sourceUpdatedAt: string;
  snapshot: GitHubIssueSnapshot;
  pullRequest?: {
    number: number;
    url: string;
    state: "open";
  };
}

export function importGitHubIssueTask(input: ImportGitHubIssueInput): {
  issue: GitHubIssueLink;
  taskId: string;
  created: boolean;
} {
  const db = getDb();
  const now = new Date().toISOString();
  const initialStatus = input.pullRequest ? "done" : "backlog";
  let taskId = "";
  let created = false;

  db.transaction((tx) => {
    tx.insert(githubIssues)
      .values({
        projectId: input.projectId,
        issueNumber: input.issueNumber,
        nodeId: input.nodeId,
        htmlUrl: input.htmlUrl,
        state: input.state,
        metadataJson: JSON.stringify(input.snapshot),
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSyncedAt: now,
        ...(input.pullRequest
          ? {
              prNumber: input.pullRequest.number,
              prUrl: input.pullRequest.url,
              prState: input.pullRequest.state,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [githubIssues.projectId, githubIssues.issueNumber],
        set: {
          nodeId: input.nodeId,
          htmlUrl: input.htmlUrl,
          state: input.state,
          metadataJson: JSON.stringify(input.snapshot),
          sourceUpdatedAt: input.sourceUpdatedAt,
          lastSyncedAt: now,
          syncError: null,
          ...(input.pullRequest
            ? {
                prNumber: input.pullRequest.number,
                prUrl: input.pullRequest.url,
                prState: input.pullRequest.state,
              }
            : {}),
          updatedAt: now,
        },
      })
      .run();

    const linked = tx
      .select()
      .from(githubIssues)
      .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
      .get();
    if (!linked) throw new Error("GitHub issue upsert did not return a row");

    const title = `#${input.issueNumber} ${input.snapshot.title}`;
    const description = renderIssueDescription(input);
    const tags = [...new Set(["github", ...input.snapshot.labels])].slice(0, 50);
    if (linked.taskId) {
      taskId = linked.taskId;
      tx.update(tasks)
        .set({ title, description, tags: JSON.stringify(tags), paused: input.state === "closed", updatedAt: now })
        .where(eq(tasks.id, taskId))
        .run();
      return;
    }

    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new Error(`Project ${input.projectId} not found`);
    taskId = crypto.randomUUID();
    const maxPosition = tx
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .get()?.value;
    const config = getProjectConfig(project.rootPath);
    const planPath = generatePlanPath(`github-issue-${input.issueNumber}`, "full", {
      plansDir: config.paths.plans,
      defaultPlanPath: config.paths.plan,
    });
    tx.insert(tasks)
      .values({
        id: taskId,
        projectId: input.projectId,
        title,
        description,
        autoMode: true,
        executionOwner: "ai",
        plannerMode: "full",
        planPath,
        planDocs: true,
        planTests: true,
        autoQueueCommitStatus: "pending",
        autoQueueCommitBaseSha: null,
        paused: input.state === "closed",
        tags: JSON.stringify(tags),
        status: initialStatus,
        position: Number(maxPosition ?? 1000) + 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(taskExecutorHistory)
      .values({
        id: crypto.randomUUID(),
        taskId,
        taskTitleSnapshot: title,
        ownershipRevision: 0,
        executionOwner: "ai",
        assigneesSnapshotJson: "[]",
        statusSnapshot: initialStatus,
        actorKind: "system",
        actorId: "github-sync",
        actorDisplayNameSnapshot: "GitHub Sync",
        reason: "github_issue_imported",
        createdAt: now,
      })
      .run();
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "github.issue_imported",
          entityType: "task",
          entityId: taskId,
          taskId,
          taskTitleSnapshot: title,
          executionOwnerSnapshot: "ai",
          assigneesSnapshot: [],
          statusSnapshot: initialStatus,
          actor: { kind: "system", id: "github-sync", displayNameSnapshot: "GitHub Sync" },
          metadata: {
            repository: `${input.owner}/${input.repository}`,
            issueNumber: input.issueNumber,
            ...(input.pullRequest ? { prNumber: input.pullRequest.number } : {}),
          },
          createdAt: now,
        }),
      )
      .run();
    tx.update(githubIssues)
      .set({ taskId, updatedAt: now })
      .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
      .run();
    created = true;
  });

  const issue = findGitHubIssue(input.projectId, input.issueNumber);
  if (!issue || !taskId) throw new Error("GitHub issue import failed");
  log.info({ projectId: input.projectId, issueNumber: input.issueNumber, taskId, created }, "GitHub issue synchronized");
  return { issue, taskId, created };
}

export function findGitHubIssue(projectId: string, issueNumber: number): GitHubIssueLink | undefined {
  const row = getDb()
    .select()
    .from(githubIssues)
    .where(and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)))
    .get();
  return row ? toIssueLink(row) : undefined;
}

export function findGitHubIssueByTaskId(taskId: string): GitHubIssueLink | undefined {
  const row = getDb().select().from(githubIssues).where(eq(githubIssues.taskId, taskId)).get();
  return row ? toIssueLink(row) : undefined;
}

export function listGitHubIssues(projectId: string): GitHubIssueLink[] {
  return getDb()
    .select()
    .from(githubIssues)
    .where(eq(githubIssues.projectId, projectId))
    .orderBy(desc(githubIssues.issueNumber))
    .all()
    .map(toIssueLink);
}

export function markGitHubIssueUnavailable(
  projectId: string,
  issueNumber: number,
  error: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const issue = tx
      .select({ taskId: githubIssues.taskId })
      .from(githubIssues)
      .where(
        and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)),
      )
      .get();
    tx.update(githubIssues)
      .set({ syncError: error, lastSyncedAt: now, updatedAt: now })
      .where(
        and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)),
      )
      .run();
    if (issue?.taskId) {
      tx.update(tasks)
        .set({ paused: true, updatedAt: now })
        .where(eq(tasks.id, issue.taskId))
        .run();
    }
  });
}

export function updateGitHubPullRequest(input: {
  projectId: string;
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  prState: "open" | "closed" | "merged";
  prChecksStatus?: "pending" | "success" | "failure" | null;
  reviewState?: "pending" | "approved" | "changes_requested" | null;
  lastReviewId?: number | null;
  reviewFingerprint?: string | null;
}): GitHubIssueLink | undefined {
  const now = new Date().toISOString();
  getDb()
    .update(githubIssues)
    .set({
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      prState: input.prState,
      ...(input.prChecksStatus !== undefined ? { prChecksStatus: input.prChecksStatus } : {}),
      ...(input.reviewState !== undefined ? { reviewState: input.reviewState } : {}),
      ...(input.lastReviewId !== undefined ? { lastReviewId: input.lastReviewId } : {}),
      ...(input.reviewFingerprint !== undefined ? { reviewFingerprint: input.reviewFingerprint } : {}),
      syncError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
    .run();
  return findGitHubIssue(input.projectId, input.issueNumber);
}

export function getGitHubIssueReviewFingerprint(projectId: string, issueNumber: number): string | null {
  return getDb()
    .select({ value: githubIssues.reviewFingerprint })
    .from(githubIssues)
    .where(and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)))
    .get()?.value ?? null;
}
