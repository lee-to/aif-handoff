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
}

export const TASK_EVENTS = [
  "start_ai",
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
  | "sync:plan_pushed";

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

// ── Chat session types ──────────────────────────────────────

export type ChatSessionSource = "web" | "cli" | "agent";

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  agentSessionId: string | null;
  source: ChatSessionSource;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatSessionInput {
  projectId: string;
  title?: string;
}

export interface UpdateChatSessionInput {
  title?: string;
}

export interface ChatSessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// ── Chat types ──────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
}

// ── Chat actions (structured blocks in AI responses) ───────

export interface ChatActionCreateTask {
  type: "create_task";
  title: string;
  description: string;
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
