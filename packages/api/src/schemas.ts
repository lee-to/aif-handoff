import { z } from "zod";
import { TASK_EVENTS, TASK_STATUSES, getEnv } from "@aif/shared";

const taskAttachmentSchema = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().max(200),
  size: z.number().int().min(0).max(10_000_000),
  content: z.string().max(2_000_000).nullable(),
  /** Relative path in storage/ — present for file-backed attachments */
  path: z.string().max(1000).optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  rootPath: z.string().min(1, "Root path is required"),
  plannerMaxBudgetUsd: z.number().positive().optional(),
  planCheckerMaxBudgetUsd: z.number().positive().optional(),
  implementerMaxBudgetUsd: z.number().positive().optional(),
  reviewSidecarMaxBudgetUsd: z.number().positive().optional(),
});

export const createTaskSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  title: z.string().min(1, "Title is required").max(500),
  description: z.string().default(""),
  attachments: z.array(taskAttachmentSchema).max(10).default([]),
  priority: z.number().int().min(0).max(5).default(0),
  autoMode: z.boolean().default(true),
  isFix: z.boolean().default(false),
  plannerMode: z.enum(["fast", "full"]).default("fast"),
  planPath: z.string().max(500).optional(),
  planDocs: z.boolean().default(false),
  planTests: z.boolean().default(false),
  skipReview: z.boolean().default(false),
  useSubagents: z.boolean().default(getEnv().AGENT_USE_SUBAGENTS),
  maxReviewIterations: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(getEnv().AGENT_MAX_REVIEW_ITERATIONS),
  paused: z.boolean().default(false),
  roadmapAlias: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(50).default([]),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  attachments: z.array(taskAttachmentSchema).max(10).optional(),
  priority: z.number().int().min(0).max(5).optional(),
  autoMode: z.boolean().optional(),
  isFix: z.boolean().optional(),
  plannerMode: z.enum(["fast", "full"]).optional(),
  planPath: z.string().max(500).optional(),
  planDocs: z.boolean().optional(),
  planTests: z.boolean().optional(),
  skipReview: z.boolean().optional(),
  useSubagents: z.boolean().optional(),
  maxReviewIterations: z.number().int().min(1).max(50).optional(),
  plan: z.string().nullable().optional(),
  implementationLog: z.string().nullable().optional(),
  reviewComments: z.string().nullable().optional(),
  agentActivityLog: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional(),
  blockedFromStatus: z.enum(TASK_STATUSES).nullable().optional(),
  retryAfter: z.string().nullable().optional(),
  retryCount: z.number().int().min(0).optional(),
  roadmapAlias: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  reworkRequested: z.boolean().optional(),
  paused: z.boolean().optional(),
  lastHeartbeatAt: z.string().nullable().optional(),
});

export const taskEventSchema = z.object({
  event: z.enum(TASK_EVENTS),
  deletePlanFile: z.boolean().optional(),
});

export const createTaskCommentSchema = z.object({
  message: z.string().min(1, "Comment message is required").max(20_000),
  attachments: z.array(taskAttachmentSchema).max(10).default([]),
});

export const reorderTaskSchema = z.object({
  position: z.number(),
});

export const broadcastTaskSchema = z.object({
  type: z.enum(["task:updated", "task:moved"]).default("task:updated"),
});

export const roadmapImportSchema = z.object({
  roadmapAlias: z.string().min(1, "Roadmap alias is required").max(200),
});

export const roadmapGenerateSchema = z.object({
  roadmapAlias: z.string().min(1, "Roadmap alias is required").max(200),
  vision: z.string().max(10000).optional(),
});

export const createChatSessionSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  title: z.string().max(200).optional(),
});

export const updateChatSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const chatRequestSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  message: z.string().min(1, "Message is required").max(50_000),
  clientId: z.string().min(1, "Client ID is required"),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  explore: z.boolean().default(false),
  taskId: z.string().optional(),
});
