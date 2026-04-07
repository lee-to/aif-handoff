export const TASK_STATUSES = [
  "backlog",
  "planning",
  "plan_ready",
  "implementing",
  "review",
  "blocked_external",
  "done",
  "verified",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd: number | null;
  planCheckerMaxBudgetUsd: number | null;
  implementerMaxBudgetUsd: number | null;
  reviewSidecarMaxBudgetUsd: number | null;
  parallelEnabled: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
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

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  attachments?: TaskCommentAttachment[];
  autoMode: boolean;
  isFix: boolean;
  plannerMode: string;
  planPath: string;
  planDocs: boolean;
  planTests: boolean;
  skipReview: boolean;
  useSubagents: boolean;
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
  paused: boolean;
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: "human" | "agent";
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
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  maxReviewIterations?: number;
  paused?: boolean;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  roadmapAlias?: string;
  tags?: string[];
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
  paused?: boolean;
  lastHeartbeatAt?: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
}

export const TASK_EVENTS = [
  "start_ai",
  "accept_existing_plan",
  "start_implementation",
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
  | "task:created"
  | "task:updated"
  | "task:deleted"
  | "task:moved"
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
  | "task:activity";

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
    | ChatSession;
}

export const RuntimeTransport = {
  /** Agent SDK — in-process query */
  SDK: "sdk",
  /** CLI subprocess — spawn a binary and parse stdout */
  CLI: "cli",
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
  defaultApiKeyEnvVar?: string | null;
  defaultModelPlaceholder?: string | null;
  supportedTransports?: string[];
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
  clientId: string;
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

export interface ChatDonePayload {
  conversationId: string;
}

export interface ChatErrorPayload {
  conversationId: string;
  message: string;
  code?: string;
}
