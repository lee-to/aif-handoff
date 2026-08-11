import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  AuditActorKind,
  AutoQueueCommitStatus,
  ExecutionOwner,
  ParticipantRole,
  TaskStatus,
} from "./types.js";

export const projects = sqliteTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  plannerMaxBudgetUsd: real("planner_max_budget_usd"),
  planCheckerMaxBudgetUsd: real("plan_checker_max_budget_usd"),
  implementerMaxBudgetUsd: real("implementer_max_budget_usd"),
  reviewSidecarMaxBudgetUsd: real("review_sidecar_max_budget_usd"),
  pinnedAt: text("pinned_at"),
  groupName: text("group_name"),
  parallelEnabled: integer("parallel_enabled", { mode: "boolean" }).notNull().default(false),
  autoQueueMode: integer("auto_queue_mode", { mode: "boolean" }).notNull().default(false),
  defaultTaskRuntimeProfileId: text("default_task_runtime_profile_id"),
  defaultPlanRuntimeProfileId: text("default_plan_runtime_profile_id"),
  defaultReviewRuntimeProfileId: text("default_review_runtime_profile_id"),
  defaultChatRuntimeProfileId: text("default_chat_runtime_profile_id"),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey().notNull().default(1),
  defaultTaskRuntimeProfileId: text("default_task_runtime_profile_id"),
  defaultPlanRuntimeProfileId: text("default_plan_runtime_profile_id"),
  defaultReviewRuntimeProfileId: text("default_review_runtime_profile_id"),
  defaultChatRuntimeProfileId: text("default_chat_runtime_profile_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type NewAppSettingsRow = typeof appSettings.$inferInsert;

export const participants = sqliteTable("participants", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull(),
  normalizedUsername: text("normalized_username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<ParticipantRole>().notNull().default("member"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  deactivatedAt: text("deactivated_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ParticipantRow = typeof participants.$inferSelect;
export type NewParticipantRow = typeof participants.$inferInsert;

export const participantSessions = sqliteTable("participant_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  tokenDigest: text("token_digest").notNull().unique(),
  csrfTokenDigest: text("csrf_token_digest").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ParticipantSessionRow = typeof participantSessions.$inferSelect;
export type NewParticipantSessionRow = typeof participantSessions.$inferInsert;

export const tasks = sqliteTable("tasks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"),
  autoMode: integer("auto_mode", { mode: "boolean" }).notNull().default(true),
  executionOwner: text("execution_owner").$type<ExecutionOwner>().notNull().default("ai"),
  ownershipRevision: integer("ownership_revision").notNull().default(0),
  isFix: integer("is_fix", { mode: "boolean" }).notNull().default(false),
  plannerMode: text("planner_mode").notNull().default("fast"),
  planPath: text("plan_path").notNull().default(".ai-factory/PLAN.md"),
  planDocs: integer("plan_docs", { mode: "boolean" }).notNull().default(false),
  planTests: integer("plan_tests", { mode: "boolean" }).notNull().default(false),
  skipReview: integer("skip_review", { mode: "boolean" }).notNull().default(false),
  useSubagents: integer("use_subagents", { mode: "boolean" }).notNull().default(false),
  runPlanImprove: integer("run_plan_improve", { mode: "boolean" }).notNull().default(false),
  runPostVerify: integer("run_post_verify", { mode: "boolean" }).notNull().default(false),
  autoQa: integer("auto_qa", { mode: "boolean" }).notNull().default(false),
  qaChangeSummary: text("qa_change_summary"),
  qaTestPlan: text("qa_test_plan"),
  qaTestCases: text("qa_test_cases"),
  qaStatus: text("qa_status")
    .$type<"idle" | "running" | "done" | "error">()
    .notNull()
    .default("idle"),
  status: text("status").$type<TaskStatus>().notNull().default("backlog"),
  priority: integer("priority").notNull().default(0),
  position: real("position").notNull().default(1000.0),
  plan: text("plan"),
  implementationLog: text("implementation_log"),
  reviewComments: text("review_comments"),
  agentActivityLog: text("agent_activity_log"),
  blockedReason: text("blocked_reason"),
  blockedFromStatus: text("blocked_from_status").$type<TaskStatus | null>(),
  retryAfter: text("retry_after"),
  retryCount: integer("retry_count").notNull().default(0),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  roadmapAlias: text("roadmap_alias"),
  tags: text("tags").notNull().default("[]"),
  reworkRequested: integer("rework_requested", { mode: "boolean" }).notNull().default(false),
  reviewIterationCount: integer("review_iteration_count").notNull().default(0),
  maxReviewIterations: integer("max_review_iterations").notNull().default(3),
  manualReviewRequired: integer("manual_review_required", { mode: "boolean" })
    .notNull()
    .default(false),
  autoReviewStateJson: text("auto_review_state_json"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  lastHeartbeatAt: text("last_heartbeat_at"),
  lastSyncedAt: text("last_synced_at"),
  runtimeProfileId: text("runtime_profile_id"),
  modelOverride: text("model_override"),
  runtimeOptionsJson: text("runtime_options_json"),
  sessionId: text("session_id"),
  activeRuntimeStatus: text("active_runtime_status").$type<TaskStatus | null>(),
  activeRuntimeSelectionJson: text("active_runtime_selection_json"),
  runtimeLimitSnapshotJson: text("runtime_limit_snapshot_json"),
  runtimeLimitUpdatedAt: text("runtime_limit_updated_at"),
  lockedBy: text("locked_by"),
  lockedUntil: text("locked_until"),
  scheduledAt: text("scheduled_at"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  autoQueueCommitStatus: text("auto_queue_commit_status").$type<AutoQueueCommitStatus | null>(),
  autoQueueCommitBaseSha: text("auto_queue_commit_base_sha"),
  commitSha: text("commit_sha"),
  autoQueueCommitError: text("auto_queue_commit_error"),
  autoQueueCommitCompletedAt: text("auto_queue_commit_completed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

export const taskComments = sqliteTable("task_comments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  taskId: text("task_id").notNull(),
  author: text("author").$type<"human" | "agent">().notNull().default("human"),
  participantId: text("participant_id").references(() => participants.id, {
    onDelete: "set null",
  }),
  message: text("message").notNull(),
  attachments: text("attachments").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;

export const taskAssignments = sqliteTable(
  "task_assignments",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    assignedByKind: text("assigned_by_kind").$type<AuditActorKind>().notNull(),
    assignedById: text("assigned_by_id"),
    assignedByDisplayNameSnapshot: text("assigned_by_display_name_snapshot"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.participantId] })],
);

export type TaskAssignmentRow = typeof taskAssignments.$inferSelect;
export type NewTaskAssignmentRow = typeof taskAssignments.$inferInsert;

export const taskExecutorHistory = sqliteTable("task_executor_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  taskId: text("task_id").notNull(),
  taskTitleSnapshot: text("task_title_snapshot").notNull(),
  ownershipRevision: integer("ownership_revision").notNull(),
  executionOwner: text("execution_owner").$type<ExecutionOwner>().notNull(),
  assigneesSnapshotJson: text("assignees_snapshot_json").notNull().default("[]"),
  statusSnapshot: text("status_snapshot").$type<TaskStatus>().notNull(),
  actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
  actorId: text("actor_id"),
  actorDisplayNameSnapshot: text("actor_display_name_snapshot"),
  reason: text("reason"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type TaskExecutorHistoryRow = typeof taskExecutorHistory.$inferSelect;
export type NewTaskExecutorHistoryRow = typeof taskExecutorHistory.$inferInsert;

export const auditEvents = sqliteTable("audit_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  taskId: text("task_id"),
  taskTitleSnapshot: text("task_title_snapshot"),
  participantId: text("participant_id"),
  participantDisplayNameSnapshot: text("participant_display_name_snapshot"),
  executionOwnerSnapshot: text("execution_owner_snapshot").$type<ExecutionOwner | null>(),
  assigneesSnapshotJson: text("assignees_snapshot_json"),
  statusSnapshot: text("status_snapshot").$type<TaskStatus | null>(),
  actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
  actorId: text("actor_id"),
  actorDisplayNameSnapshot: text("actor_display_name_snapshot"),
  reason: text("reason"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

export const githubRepositories = sqliteTable("github_repositories", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  htmlUrl: text("html_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  tokenEnvVar: text("token_env_var").notNull().default("GITHUB_TOKEN"),
  eligibilityJson: text("eligibility_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastSyncedAt: text("last_synced_at"),
  syncError: text("sync_error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type GitHubRepositoryRow = typeof githubRepositories.$inferSelect;
export type NewGitHubRepositoryRow = typeof githubRepositories.$inferInsert;

export const githubIssues = sqliteTable(
  "github_issues",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueNumber: integer("issue_number").notNull(),
    taskId: text("task_id")
      .unique()
      .references(() => tasks.id, { onDelete: "set null" }),
    nodeId: text("node_id").notNull(),
    htmlUrl: text("html_url").notNull(),
    state: text("state").$type<"open" | "closed">().notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    lastSyncedAt: text("last_synced_at").notNull(),
    syncError: text("sync_error"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prState: text("pr_state").$type<"open" | "closed" | "merged" | null>(),
    prChecksStatus: text("pr_checks_status").$type<"pending" | "success" | "failure" | null>(),
    reviewState: text("review_state").$type<"pending" | "approved" | "changes_requested" | null>(),
    lastReviewId: integer("last_review_id"),
    reviewFingerprint: text("review_fingerprint"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.issueNumber] })],
);

export type GitHubIssueRow = typeof githubIssues.$inferSelect;
export type NewGitHubIssueRow = typeof githubIssues.$inferInsert;

export const runtimeProfiles = sqliteTable("runtime_profiles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id"),
  name: text("name").notNull(),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  transport: text("transport"),
  baseUrl: text("base_url"),
  apiKeyEnvVar: text("api_key_env_var"),
  defaultModel: text("default_model"),
  headersJson: text("headers_json").notNull().default("{}"),
  optionsJson: text("options_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeLimitSnapshotJson: text("runtime_limit_snapshot_json"),
  runtimeLimitUpdatedAt: text("runtime_limit_updated_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfileRow = typeof runtimeProfiles.$inferInsert;

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  title: text("title").notNull().default("New Chat"),
  agentSessionId: text("agent_session_id"),
  runtimeProfileId: text("runtime_profile_id"),
  runtimeSessionId: text("runtime_session_id"),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type NewChatSessionRow = typeof chatSessions.$inferInsert;

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  attachments: text("attachments"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;

/**
 * Append-only token usage log. Every successful LLM call that flows through
 * the runtime registry wrapper produces one row here. Per-entity aggregate
 * counters (on tasks / projects / chat_sessions) are updated in the same
 * transaction so reads stay cheap, but this table is the source of truth for
 * auditing and per-source breakdowns. Scope fields are nullable — a chat run
 * has a `chat_session_id` but no `task_id`, a subagent run has `task_id` but
 * no `chat_session_id`, a commit run has only `project_id`, and so on.
 */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  source: text("source").notNull(),
  projectId: text("project_id"),
  taskId: text("task_id"),
  chatSessionId: text("chat_session_id"),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  profileId: text("profile_id"),
  transport: text("transport"),
  workflowKind: text("workflow_kind"),
  usageReporting: text("usage_reporting").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  costUsd: real("cost_usd"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEventRow = typeof usageEvents.$inferInsert;

export type RuntimeWarmupSessionStatus = "creating" | "ready" | "failed" | "cleared" | "expired";

/**
 * Reusable seed sessions created ahead of task execution. A ready row can be
 * forked by compatible runtimes until its TTL expires or a newer warmup
 * clears it for the same runtime/profile/model scope.
 */
export const runtimeWarmupSessions = sqliteTable("runtime_warmup_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  runtimeProfileId: text("runtime_profile_id"),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  transport: text("transport"),
  model: text("model"),
  sourceSessionId: text("source_session_id"),
  status: text("status").$type<RuntimeWarmupSessionStatus>().notNull().default("creating"),
  ttlSeconds: integer("ttl_seconds").notNull(),
  expiresAt: text("expires_at").notNull(),
  summary: text("summary"),
  errorMessage: text("error_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type RuntimeWarmupSessionRow = typeof runtimeWarmupSessions.$inferSelect;
export type NewRuntimeWarmupSessionRow = typeof runtimeWarmupSessions.$inferInsert;

/**
 * Rebuildable Codex session index used by hot request paths.
 * Source of truth stays on disk (~/.codex/sessions/*.jsonl).
 */
export const codexSessions = sqliteTable("codex_sessions", {
  sessionId: text("session_id").primaryKey(),
  filePath: text("file_path").notNull().unique(),
  title: text("title"),
  projectRoot: text("project_root"),
  accountFingerprint: text("account_fingerprint"),
  sourceCreatedAt: text("source_created_at"),
  sourceUpdatedAt: text("source_updated_at"),
  messageCount: integer("message_count").notNull().default(0),
  previewText: text("preview_text"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
  lastIndexedAt: text("last_indexed_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexSessionRow = typeof codexSessions.$inferSelect;
export type NewCodexSessionRow = typeof codexSessions.$inferInsert;

/**
 * Tracks file-level dirtiness/cursors for Codex session reconcile passes.
 */
export const codexSessionFiles = sqliteTable("codex_session_files", {
  filePath: text("file_path").primaryKey(),
  sessionId: text("session_id"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
  parsedOffset: integer("parsed_offset").notNull().default(0),
  pendingTail: text("pending_tail").notNull().default(""),
  missing: integer("missing", { mode: "boolean" }).notNull().default(false),
  importVersion: integer("import_version").notNull().default(1),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexSessionFileRow = typeof codexSessionFiles.$inferSelect;
export type NewCodexSessionFileRow = typeof codexSessionFiles.$inferInsert;

/**
 * Latest known Codex usage-limit snapshot per account/project/limit scope.
 */
export const codexLimitHeads = sqliteTable("codex_limit_heads", {
  headKey: text("head_key").primaryKey(),
  accountFingerprint: text("account_fingerprint").notNull(),
  projectRoot: text("project_root"),
  limitId: text("limit_id").notNull(),
  model: text("model"),
  source: text("source").notNull().default("codex"),
  snapshotJson: text("snapshot_json").notNull(),
  observedAt: text("observed_at").notNull(),
  sessionId: text("session_id"),
  filePath: text("file_path"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexLimitHeadRow = typeof codexLimitHeads.$inferSelect;
export type NewCodexLimitHeadRow = typeof codexLimitHeads.$inferInsert;

/**
 * Bounded recent Codex limit snapshots used for diagnostics/history.
 */
export const codexLimitHistory = sqliteTable("codex_limit_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  headKey: text("head_key").notNull(),
  accountFingerprint: text("account_fingerprint").notNull(),
  projectRoot: text("project_root"),
  limitId: text("limit_id").notNull(),
  model: text("model"),
  snapshotJson: text("snapshot_json").notNull(),
  observedAt: text("observed_at").notNull(),
  sessionId: text("session_id"),
  filePath: text("file_path"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexLimitHistoryRow = typeof codexLimitHistory.$inferSelect;
export type NewCodexLimitHistoryRow = typeof codexLimitHistory.$inferInsert;

/**
 * Generic index cursor/watermark state for Codex reconcile pipeline.
 */
export const codexIndexCursors = sqliteTable("codex_index_cursors", {
  cursorKey: text("cursor_key").primaryKey(),
  cursorValue: text("cursor_value"),
  cursorJson: text("cursor_json"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexIndexCursorRow = typeof codexIndexCursors.$inferSelect;
export type NewCodexIndexCursorRow = typeof codexIndexCursors.$inferInsert;
