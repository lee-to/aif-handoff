import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { TaskStatus } from "./types.js";

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
  parallelEnabled: integer("parallel_enabled", { mode: "boolean" }).notNull().default(false),
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

export const tasks = sqliteTable("tasks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"),
  autoMode: integer("auto_mode", { mode: "boolean" }).notNull().default(true),
  isFix: integer("is_fix", { mode: "boolean" }).notNull().default(false),
  plannerMode: text("planner_mode").notNull().default("fast"),
  planPath: text("plan_path").notNull().default(".ai-factory/PLAN.md"),
  planDocs: integer("plan_docs", { mode: "boolean" }).notNull().default(false),
  planTests: integer("plan_tests", { mode: "boolean" }).notNull().default(false),
  skipReview: integer("skip_review", { mode: "boolean" }).notNull().default(false),
  useSubagents: integer("use_subagents", { mode: "boolean" }).notNull().default(true),
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
  lockedBy: text("locked_by"),
  lockedUntil: text("locked_until"),
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
  message: text("message").notNull(),
  attachments: text("attachments").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;

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
