// Browser-safe exports — no Node.js dependencies (no better-sqlite3, pino, etc.)

export {
  TASK_STATUSES,
  type TaskStatus,
  type Project,
  type CreateProjectInput,
  type Task,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TaskComment,
  type TaskCommentAttachment,
  type CreateTaskCommentInput,
  TASK_EVENTS,
  type TaskEvent,
  type TaskEventInput,
  type ReorderTaskInput,
  type WsEventType,
  type WsEvent,
  type RoadmapCompletePayload,
  type RoadmapErrorPayload,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatAttachment,
  type ChatRequest,
  type ChatStreamTokenPayload,
  type ChatDonePayload,
  type ChatErrorPayload,
  type ChatAction,
  type ChatActionCreateTask,
  type RuntimeProfile,
  type CreateRuntimeProfileInput,
  type UpdateRuntimeProfileInput,
  type EffectiveRuntimeProfileSource,
  type EffectiveRuntimeProfileSelection,
  type ChatSessionSource,
  type ChatSession,
  type CreateChatSessionInput,
  type UpdateChatSessionInput,
  type ChatSessionMessage,
} from "./types.js";

export { STATUS_CONFIG, ORDERED_STATUSES } from "./constants.js";
export { HUMAN_ACTIONS_BY_STATUS } from "./stateMachine.js";
export { withTimeout } from "./withTimeout.js";

// Plan path utilities (pure functions, browser-safe — separate module with no Node.js deps)
export { slugify, generatePlanPath } from "./planPath.js";
export type { GeneratePlanPathOptions } from "./planPath.js";

// Sync types (browser-safe subset — types only, no Node.js logger dependency)
export type { SyncDirection, ConflictResolution, SyncEvent, PlanAnnotation } from "./sync.js";
