export const TASK_STATUSES = [
  "backlog",
  "planning",
  "improve",
  "plan_ready",
  "implementing",
  "review",
  "verify",
  "blocked_external",
  "done",
  "verified",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PARTICIPANT_ROLES = ["admin", "member"] as const;

export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const EXECUTION_OWNERS = ["ai", "human"] as const;

export type ExecutionOwner = (typeof EXECUTION_OWNERS)[number];

export const AUDIT_ACTOR_KINDS = ["participant", "agent", "system", "anonymous"] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export type AutoQueueCommitStatus =
  | "pending"
  | "running"
  | "committed"
  | "no_changes"
  | "not_applicable"
  | "failed";

export const AUTO_REVIEW_STRATEGIES = ["full_re_review", "closure_first"] as const;

export type AutoReviewStrategy = (typeof AUTO_REVIEW_STRATEGIES)[number];

export const AUTO_REVIEW_FINDING_SOURCES = [
  "code_review",
  "security_audit",
  "review_gate",
] as const;

export type AutoReviewFindingSource = (typeof AUTO_REVIEW_FINDING_SOURCES)[number];

export interface AutoReviewFinding {
  id: string;
  text: string;
  source: AutoReviewFindingSource;
}

export interface AutoReviewState {
  strategy: AutoReviewStrategy;
  iteration: number;
  findings: AutoReviewFinding[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd: number | null;
  planCheckerMaxBudgetUsd: number | null;
  implementerMaxBudgetUsd: number | null;
  reviewSidecarMaxBudgetUsd: number | null;
  pinnedAt: string | null;
  groupName: string | null;
  parallelEnabled: boolean;
  autoQueueMode: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
  /** Aggregate token/cost usage across ALL sources (tasks, chat, commit, roadmap). */
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubEligibility {
  labels: string[];
  assignee: string | null;
  milestone: string | null;
}

export interface GitHubRepositoryConnection {
  projectId: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitHubEligibility;
  enabled: boolean;
  tokenConfigured: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueCommentSnapshot {
  id: number;
  author: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueSnapshot {
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  comments: GitHubIssueCommentSnapshot[];
}

export interface GitHubIssueLink {
  projectId: string;
  issueNumber: number;
  taskId: string | null;
  nodeId: string;
  htmlUrl: string;
  state: "open" | "closed";
  metadata: GitHubIssueSnapshot;
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  syncError: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: "open" | "closed" | "merged" | null;
  prChecksStatus: "pending" | "success" | "failure" | null;
  reviewState: "pending" | "approved" | "changes_requested" | null;
  lastReviewId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd?: number;
  planCheckerMaxBudgetUsd?: number;
  implementerMaxBudgetUsd?: number;
  reviewSidecarMaxBudgetUsd?: number;
  parallelEnabled?: boolean;
  autoQueueMode?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}

export interface UpdateProjectOrganizationInput {
  pinned?: boolean;
  groupName?: string | null;
}

export interface AppSettings {
  id: number;
  defaultTaskRuntimeProfileId: string | null;
  defaultPlanRuntimeProfileId: string | null;
  defaultReviewRuntimeProfileId: string | null;
  defaultChatRuntimeProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateAppSettingsInput {
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}

export interface TaskCommentAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Inline content (text or base64). Deprecated for binary files — use `path` instead. */
  content: string | null;
  /** Relative path in storage/ directory. Present for file-backed attachments. */
  path?: string;
}

export interface ParticipantSummary {
  id: string;
  displayName: string;
  role: ParticipantRole;
  active: boolean;
}

export interface Participant extends ParticipantSummary {
  username: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
}

export interface AuthSessionState {
  participantsModeEnabled: boolean;
  authenticated: boolean;
  participant: ParticipantSummary | null;
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface CreateParticipantInput {
  username: string;
  displayName: string;
  password: string;
  role?: ParticipantRole;
}

export interface UpdateParticipantInput {
  displayName?: string;
  role?: ParticipantRole;
}

export interface ResetParticipantPasswordInput {
  password: string;
}

export interface TaskAssigneeSummary {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  active: boolean;
}

export interface TaskPermissions {
  canAssign: boolean;
  canHandoff: boolean;
  canSelfAssign: boolean;
  canAct: boolean;
  canComment: boolean;
  permittedActions: TaskEvent[];
}

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  displayNameSnapshot: string | null;
}

export interface TaskExecutorHistoryEntry {
  id: string;
  taskId: string;
  taskTitleSnapshot: string;
  ownershipRevision: number;
  executionOwner: ExecutionOwner;
  assignees: TaskAssigneeSummary[];
  statusSnapshot: TaskStatus;
  actor: AuditActor;
  reason: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  taskId: string | null;
  taskTitleSnapshot: string | null;
  participantId: string | null;
  participantDisplayNameSnapshot: string | null;
  executionOwnerSnapshot: ExecutionOwner | null;
  assigneesSnapshot: TaskAssigneeSummary[] | null;
  statusSnapshot: TaskStatus | null;
  actor: AuditActor;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TaskOwnership {
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
}

export interface HandoffTaskInput {
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner;
  expectedStatus?: TaskStatus;
  reason?: string;
  resumeAction?: TaskEvent;
}

export type TaskOwnershipConflictCode =
  | "task_not_found"
  | "task_locked"
  | "ownership_revision_conflict"
  | "inactive_assignee"
  | "invalid_ownership_transition"
  | "ai_handoff_required";

export interface TaskOwnershipConflict {
  code: TaskOwnershipConflictCode;
  message: string;
  ownership?: TaskOwnership;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  attachments?: TaskCommentAttachment[];
  autoMode: boolean;
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
  permissions?: TaskPermissions;
  isFix: boolean;
  plannerMode: string;
  planPath: string;
  planDocs: boolean;
  planTests: boolean;
  skipReview: boolean;
  useSubagents: boolean;
  runPlanImprove: boolean;
  runPostVerify: boolean;
  autoQa: boolean;
  qaChangeSummary: string | null;
  qaTestPlan: string | null;
  qaTestCases: string | null;
  qaStatus: "idle" | "running" | "done" | "error";
  status: TaskStatus;
  priority: number;
  position: number;
  plan: string | null;
  implementationLog: string | null;
  reviewComments: string | null;
  agentActivityLog: string | null;
  blockedReason: string | null;
  blockedFromStatus: TaskStatus | null;
  retryAfter: string | null;
  retryCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias: string | null;
  tags: string[];
  reworkRequested: boolean;
  reviewIterationCount: number;
  maxReviewIterations: number;
  manualReviewRequired: boolean;
  autoReviewState: AutoReviewState | null;
  paused: boolean;
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  sessionId: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  scheduledAt: string | null;
  branchName: string | null;
  worktreePath: string | null;
  autoQueueCommitStatus?: AutoQueueCommitStatus | null;
  autoQueueCommitBaseSha?: string | null;
  commitSha?: string | null;
  autoQueueCommitError?: string | null;
  autoQueueCommitCompletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  github?: GitHubIssueLink | null;
}

export interface TaskListItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  autoMode: boolean;
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
  permissions?: TaskPermissions;
  isFix: boolean;
  status: TaskStatus;
  priority: number;
  position: number;
  blockedReason: string | null;
  blockedFromStatus: TaskStatus | null;
  retryAfter: string | null;
  retryCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias: string | null;
  tags: string[];
  reworkRequested: boolean;
  reviewIterationCount: number;
  maxReviewIterations: number;
  manualReviewRequired: boolean;
  paused: boolean;
  lastSyncedAt: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasPlan: boolean;
}

export interface ProjectTaskPreview {
  id: string;
  title: string;
}

export interface ProjectTaskOverview {
  projectId: string;
  lastActivityAt: string | null;
  totalTasks: number;
  completedTasks: number;
  verifiedTasks: number;
  backlogTasks: number;
  activeTasks: number;
  blockedTasks: number;
  autoModeTasks: number;
  fixTasks: number;
  totalRetries: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalCostUsd: number;
  statusCounts: Record<TaskStatus, number>;
  statusPreviews: Record<TaskStatus, ProjectTaskPreview[]>;
}

export interface TaskActiveRuntimeSelection {
  status: TaskStatus;
  profileMode: "task" | "plan" | "review";
  source: string;
  profileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: RuntimeTransport;
  model: string | null;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  pinnedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: "human" | "agent";
  participantId: string | null;
  participant: ParticipantSummary | null;
  message: string;
  attachments: TaskCommentAttachment[];
  createdAt: string;
}

/** POST /tasks/:id/comments body */
export interface CreateTaskCommentInput {
  message: string;
  attachments?: TaskCommentAttachment[];
}

/** POST /tasks body */
export interface CreateTaskInput {
  projectId: string;
  title: string;
  description: string;
  priority?: number;
  autoMode?: boolean;
  executionOwner?: ExecutionOwner;
  assigneeIds?: string[];
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
  autoQa?: boolean;
  maxReviewIterations?: number;
  paused?: boolean;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  roadmapAlias?: string;
  tags?: string[];
  scheduledAt?: string | null;
}

/** PUT /tasks/:id body */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  attachments?: TaskCommentAttachment[];
  priority?: number;
  autoMode?: boolean;
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
  autoQa?: boolean;
  qaChangeSummary?: string | null;
  qaTestPlan?: string | null;
  qaTestCases?: string | null;
  qaStatus?: "idle" | "running" | "done" | "error";
  plan?: string | null;
  implementationLog?: string | null;
  reviewComments?: string | null;
  agentActivityLog?: string | null;
  blockedReason?: string | null;
  blockedFromStatus?: TaskStatus | null;
  retryAfter?: string | null;
  retryCount?: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias?: string | null;
  tags?: string[];
  reworkRequested?: boolean;
  reviewIterationCount?: number;
  maxReviewIterations?: number;
  manualReviewRequired?: boolean;
  autoReviewState?: AutoReviewState | null;
  paused?: boolean;
  lastHeartbeatAt?: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  scheduledAt?: string | null;
}

export const TASK_EVENTS = [
  "start_ai",
  "accept_existing_plan",
  "start_human_work",
  "mark_plan_ready",
  "start_implementation",
  "submit_implementation",
  "complete_review",
  "request_review_changes",
  "pass_verification",
  "fail_verification",
  "request_replanning",
  "fast_fix",
  "approve_done",
  "request_changes",
  "retry_from_blocked",
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

/** POST /tasks/:id/events body */
export interface TaskEventInput {
  event: TaskEvent;
  deletePlanFile?: boolean;
  commitOnApprove?: boolean;
}

/** PATCH /tasks/:id/position body */
export interface ReorderTaskInput {
  position: number;
}

/** WebSocket event types */
export type WsEventType =
  | "project:created"
  | "project:organization_updated"
  | "participant:created"
  | "participant:updated"
  | "participant:deactivated"
  | "auth:session_revoked"
  | "task:created"
  | "task:updated"
  | "task:deleted"
  | "task:moved"
  | "task:assignment_updated"
  | "task:handoff"
  | "task:comment_created"
  | "agent:wake"
  | "roadmap:complete"
  | "roadmap:error"
  | "chat:token"
  | "chat:done"
  | "chat:error"
  | "chat:session_created"
  | "chat:session_deleted"
  | "sync:task_created"
  | "sync:task_updated"
  | "sync:status_changed"
  | "sync:plan_pushed"
  | "task:activity"
  | "task:scheduled_fired"
  | "project:auto_queue_mode_changed"
  | "project:auto_queue_advanced"
  | "project:runtime_limit_updated"
  | "project:warmup_updated"
  | "task:commit_started"
  | "task:commit_done"
  | "task:commit_failed"
  | "task:qa_started"
  | "task:qa_done"
  | "task:qa_failed";

export interface RoadmapCompletePayload {
  projectId: string;
  roadmapAlias: string;
  created: number;
  skipped: number;
  taskIds: string[];
  byPhase: Record<number, { created: number; skipped: number }>;
}

export interface RoadmapErrorPayload {
  projectId: string;
  roadmapAlias: string;
  error: string;
  code: string;
}

/**
 * Emitted when the "create commit" checkbox is used on approve-done, to
 * surface the lifecycle of the fire-and-forget `/aif-commit` run to the UI.
 * `status` is redundant with `type` but makes the payload self-describing.
 */
export interface TaskCommitPayload {
  taskId: string;
  projectId: string;
  status: "started" | "done" | "failed";
  error?: string;
}

/**
 * Lifecycle of `/aif-qa` runs (manual via `POST /tasks/:id/run-qa` or
 * auto-triggered on `approve_done` when `task.autoQa = true`).
 */
export interface TaskQaPayload {
  taskId: string;
  projectId: string;
  status: "started" | "done" | "failed";
  error?: string;
}

export interface RuntimeLimitBroadcastPayload {
  projectId: string;
  runtimeProfileId: string | null;
  taskId?: string | null;
}

export interface WarmupBroadcastPayload {
  projectId: string;
  status: "ready" | "failed" | "partial" | "cleared" | "expired";
}

export interface ParticipantBroadcastPayload {
  participant: ParticipantSummary;
  actor: AuditActor;
}

export interface ParticipantSessionRevokedPayload {
  participantId: string;
}

export interface TaskOwnershipBroadcastPayload {
  taskId: string;
  projectId: string;
  ownership: TaskOwnership;
  actor: AuditActor;
  responsibleParticipants?: TaskAssigneeSummary[];
}

export interface TaskCommentBroadcastPayload {
  taskId: string;
  projectId: string;
  comment: TaskComment;
  actor: AuditActor;
  responsibleParticipants?: ParticipantSummary[];
}

export interface WsEvent {
  type: WsEventType;
  payload:
    | Task
    | Project
    | { id: string }
    | RoadmapCompletePayload
    | RoadmapErrorPayload
    | ChatStreamTokenPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatSession
    | TaskCommitPayload
    | TaskQaPayload
    | RuntimeLimitBroadcastPayload
    | WarmupBroadcastPayload
    | ParticipantBroadcastPayload
    | ParticipantSessionRevokedPayload
    | TaskOwnershipBroadcastPayload
    | TaskCommentBroadcastPayload;
}

export const RuntimeTransport = {
  /** Agent SDK — in-process query */
  SDK: "sdk",
  /** CLI subprocess — spawn a binary and parse stdout */
  CLI: "cli",
  /** Codex app-server subprocess over stdio JSONL */
  APP_SERVER: "app-server",
  /** HTTP API — POST to a remote runtime endpoint */
  API: "api",
} as const;

export type RuntimeTransport = (typeof RuntimeTransport)[keyof typeof RuntimeTransport];

/** All known transport values for validation and UI selects. */
export const RUNTIME_TRANSPORTS: readonly RuntimeTransport[] = Object.values(RuntimeTransport);

export function isRuntimeTransport(value: unknown): value is RuntimeTransport {
  return typeof value === "string" && RUNTIME_TRANSPORTS.includes(value as RuntimeTransport);
}

/** Runtime descriptor returned by GET /runtime-profiles/runtimes */
export interface RuntimeDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  description?: string | null;
  capabilities: Record<string, boolean>;
  defaultTransport?: string | null;
  defaultApiKeyEnvVar?: string | null;
  defaultBaseUrlEnvVar?: string | null;
  defaultBaseUrl?: string | null;
  defaultModelPlaceholder?: string | null;
  supportedTransports?: string[];
}

export interface RuntimeProfileUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number | null;
}

export interface RuntimeProfile {
  id: string;
  projectId: string | null;
  name: string;
  runtimeId: string;
  providerId: string;
  transport: string | null;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  defaultModel: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  enabled: boolean;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  lastUsage?: RuntimeProfileUsage | null;
  lastUsageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuntimeProfileInput {
  projectId?: string | null;
  name: string;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateRuntimeProfileInput {
  projectId?: string | null;
  name?: string;
  runtimeId?: string;
  providerId?: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export type EffectiveRuntimeProfileSource =
  | "task_override"
  | "project_default"
  | "system_default"
  | "none";

export interface EffectiveRuntimeProfileSelection {
  source: EffectiveRuntimeProfileSource;
  profile: RuntimeProfile | null;
  taskRuntimeProfileId: string | null;
  projectRuntimeProfileId: string | null;
  systemRuntimeProfileId: string | null;
}

export const RuntimeLimitSource = {
  PROVIDER_API: "provider_api",
  SDK_EVENT: "sdk_event",
  API_HEADERS: "api_headers",
  TURN_USAGE: "turn_usage",
} as const;

export type RuntimeLimitSource = (typeof RuntimeLimitSource)[keyof typeof RuntimeLimitSource];

export const RuntimeLimitStatus = {
  OK: "ok",
  WARNING: "warning",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
} as const;

export type RuntimeLimitStatus = (typeof RuntimeLimitStatus)[keyof typeof RuntimeLimitStatus];

export const RuntimeLimitPrecision = {
  EXACT: "exact",
  HEURISTIC: "heuristic",
} as const;

export type RuntimeLimitPrecision =
  (typeof RuntimeLimitPrecision)[keyof typeof RuntimeLimitPrecision];

export const RuntimeLimitScope = {
  REQUESTS: "requests",
  TOKENS: "tokens",
  TIME: "time",
  SPEND: "spend",
  TURN_USAGE: "turn_usage",
  MODEL_USAGE: "model_usage",
  TOOL_USAGE: "tool_usage",
  OTHER: "other",
} as const;

export type RuntimeLimitScope = (typeof RuntimeLimitScope)[keyof typeof RuntimeLimitScope];

export interface RuntimeLimitWindow {
  scope: RuntimeLimitScope;
  name?: string | null;
  unit?: string | null;
  limit?: number | null;
  remaining?: number | null;
  used?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
  warningThreshold?: number | null;
}

export interface RuntimeLimitSnapshot {
  source: RuntimeLimitSource;
  status: RuntimeLimitStatus;
  precision: RuntimeLimitPrecision;
  checkedAt: string;
  providerId: string;
  runtimeId?: string | null;
  profileId?: string | null;
  primaryScope?: RuntimeLimitScope | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
  warningThreshold?: number | null;
  windows: RuntimeLimitWindow[];
  providerMeta?: Record<string, unknown> | null;
}

export interface RuntimeLimitEventPayload {
  snapshot: RuntimeLimitSnapshot;
  rawType?: string | null;
}

// ── Chat session types ──────────────────────────────────────

export type ChatSessionSource = "web" | "cli" | "agent";

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  agentSessionId: string | null;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
  source: ChatSessionSource;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatSessionInput {
  projectId: string;
  title?: string;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  agentSessionId?: string | null;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
}

export interface ChatMessageAttachment {
  name: string;
  mimeType: string;
  size: number;
  path?: string;
}

export interface ChatSessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatMessageAttachment[];
  createdAt: string;
}

// ── Chat types ──────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatMessageAttachment[];
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
}

export interface ChatRequest {
  projectId: string;
  message: string;
  clientId?: string;
  conversationId?: string;
  sessionId?: string;
  explore?: boolean;
  /** Currently open task ID — provides context to the chat agent */
  taskId?: string;
  attachments?: ChatAttachment[];
}

// ── Chat actions (structured blocks in AI responses) ───────

export interface ChatActionCreateTask {
  type: "create_task";
  title: string;
  description: string;
  isFix?: boolean;
}

export type ChatAction = ChatActionCreateTask;

export interface ChatStreamTokenPayload {
  conversationId: string;
  token: string;
}

/**
 * Per-turn token usage reported to the frontend alongside the `chat:done`
 * event. Matches `RuntimeUsage` from `@aif/runtime` structurally, duplicated
 * here to avoid forcing `@aif/shared` to depend on the runtime layer.
 */
export interface ChatDoneUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface ChatDonePayload {
  conversationId: string;
  /** Null when the adapter/transport does not report usage for this turn. */
  usage?: ChatDoneUsage | null;
  projectId?: string;
  taskId?: string | null;
  runtimeProfileId?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}

export interface ChatErrorPayload {
  conversationId: string;
  message: string;
  code?: string;
  projectId?: string;
  taskId?: string | null;
  runtimeProfileId?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}
