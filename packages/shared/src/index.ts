// Schema
export {
  projects,
  tasks,
  taskComments,
  runtimeProfiles,
  chatSessions,
  chatMessages,
  usageEvents,
} from "./schema.js";
export type {
  ProjectRow,
  NewProjectRow,
  TaskRow,
  NewTaskRow,
  TaskCommentRow,
  NewTaskCommentRow,
  RuntimeProfileRow,
  NewRuntimeProfileRow,
  ChatSessionRow,
  NewChatSessionRow,
  ChatMessageRow,
  NewChatMessageRow,
  UsageEventRow,
  NewUsageEventRow,
} from "./schema.js";

// Types
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
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatRequest,
  type ChatStreamTokenPayload,
  type ChatDonePayload,
  type ChatErrorPayload,
  type ChatAction,
  type ChatActionCreateTask,
  isRuntimeTransport,
  RUNTIME_TRANSPORTS,
  RuntimeTransport,
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

// Database
export { getDb, createTestDb, closeDb } from "./db.js";

// Environment
export { getEnv, validateEnv } from "./env.js";
export type { Env } from "./env.js";

// Constants
export { STATUS_CONFIG, ORDERED_STATUSES } from "./constants.js";
export { applyHumanTaskEvent, HUMAN_ACTIONS_BY_STATUS, CLEAN_STATE_RESET } from "./stateMachine.js";

// Logger
export { logger, rootLogger } from "./logger.js";

// Monorepo root resolution
export { findMonorepoRoot, findMonorepoRootFromUrl } from "./monorepoRoot.js";

// Project initialization
export { initBaseProjectDirectory } from "./projectInit.js";
export {
  slugify,
  generatePlanPath,
  getCanonicalPlanPath,
  syncPlanTextToCanonicalFile,
} from "./planFile.js";
export type { GeneratePlanPathOptions } from "./planFile.js";
export { persistTaskPlan } from "./taskPlan.js";

// Path validation
export { validateProjectRootPath } from "./pathValidation.js";

// Attachment utilities
export {
  parseAttachments,
  isFileBackedAttachment,
  formatAttachmentsForPrompt,
  extractHeadings,
  looksLikeFullPlanUpdate,
  type ParsedAttachment,
} from "./attachments.js";

// Task usage metrics
export { parseTaskTokenUsage, type TaskTokenUsage } from "./taskUsage.js";

// Sync utilities
export {
  type SyncDirection,
  type ConflictResolution,
  type SyncEvent,
  type PlanAnnotation,
  parsePlanAnnotations,
  insertPlanAnnotation,
} from "./sync.js";

// Project config (config.yaml)
export {
  getProjectConfig,
  clearProjectConfigCache,
  type AifProjectConfig,
  type AifProjectPaths,
  type AifProjectWorkflow,
} from "./projectConfig.js";

// Telegram notifications
export {
  escapeMarkdown,
  sendTelegramNotification,
  type TelegramNotificationOptions,
} from "./telegram.js";

// Utilities
export { withTimeout } from "./withTimeout.js";
