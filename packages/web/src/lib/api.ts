import type {
  Task,
  TaskListItem,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskEventInput,
  TaskComment,
  CreateTaskCommentInput,
  Project,
  ProjectTaskOverview,
  CreateProjectInput,
  UpdateProjectOrganizationInput,
  ChatRequest,
  ChatSession,
  CreateChatSessionInput,
  UpdateChatSessionInput,
  ChatSessionMessage,
  ChatMessageAttachment,
  RuntimeDescriptor,
  RuntimeProfile,
  CreateRuntimeProfileInput,
  UpdateRuntimeProfileInput,
  RuntimeLimitSnapshot,
  AuthSessionState,
  Participant,
  CreateParticipantInput,
  UpdateParticipantInput,
  ResetParticipantPasswordInput,
  HandoffTaskInput,
  TaskExecutorHistoryEntry,
  TaskOwnership,
  GitHubEligibility,
  GitHubIssueLink,
  GitHubRepositoryConnection,
} from "@aif/shared/browser";

export class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export interface AifConfig {
  language?: {
    ui?: string;
    artifacts?: string;
    technical_terms?: string;
  };
  paths?: {
    description?: string;
    architecture?: string;
    docs?: string;
    roadmap?: string;
    research?: string;
    rules_file?: string;
    plan?: string;
    plans?: string;
    fix_plan?: string;
    security?: string;
    references?: string;
    patches?: string;
    evolutions?: string;
    evolution?: string;
    specs?: string;
    rules?: string;
    qa?: string;
  };
  workflow?: {
    auto_create_dirs?: boolean;
    plan_id_format?: string;
    analyze_updates_architecture?: boolean;
    architecture_updates_roadmap?: boolean;
    verify_mode?: string;
  };
  git?: {
    enabled?: boolean;
    base_branch?: string;
    create_branches?: boolean;
    branch_prefix?: string;
    skip_push_after_commit?: boolean;
  };
  rules?: {
    base?: string;
  };
}

export interface AppRuntimeDefaultsResponse {
  defaultTaskRuntimeProfileId: string | null;
  defaultPlanRuntimeProfileId: string | null;
  defaultReviewRuntimeProfileId: string | null;
  defaultChatRuntimeProfileId: string | null;
  resolvedDefaultTaskRuntimeProfileId: string | null;
  resolvedDefaultPlanRuntimeProfileId: string | null;
  resolvedDefaultReviewRuntimeProfileId: string | null;
  resolvedDefaultChatRuntimeProfileId: string | null;
}

const API_PREFIX = import.meta.env.DEV ? "" : "/api";
const API_BASE = "/tasks";
const REQUEST_TIMEOUT_MS = 15_000;
export const PLAN_FAST_FIX_TIMEOUT_MS = 200_000;
const CHAT_TIMEOUT_MS = 300_000;
const IMPORT_ROADMAP_TIMEOUT_MS = 300_000;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_SESSION_PATH = "/auth/session";
const AUTH_LOGIN_PATH = "/auth/login";

type ParticipantAuthState = "unknown" | "disabled" | "authenticated" | "unauthenticated";

let participantAuthState: ParticipantAuthState = "unknown";
let participantCsrfToken: string | null = null;
let participantSessionExpiresAt: number | null = null;
let authSessionRefresh: Promise<AuthSessionState> | null = null;
const authenticationRequiredListeners = new Set<() => void>();

function requestPathForLog(url: string): string {
  return url.split("?")[0] ?? url;
}

function apiErrorCode(error: ApiError): string | null {
  if (typeof error.data !== "object" || error.data === null || !("code" in error.data)) {
    return null;
  }
  const code = (error.data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function emitAuthenticationRequired(): void {
  for (const listener of authenticationRequiredListeners) {
    listener();
  }
}

function rememberAuthSession(session: AuthSessionState): void {
  const wasAuthenticated = participantAuthState === "authenticated";
  participantCsrfToken = session.csrfToken;
  participantSessionExpiresAt = session.expiresAt ? Date.parse(session.expiresAt) : null;
  participantAuthState = !session.participantsModeEnabled
    ? "disabled"
    : session.authenticated
      ? "authenticated"
      : "unauthenticated";
  console.debug("[auth] Session state updated", {
    state: participantAuthState,
    participantId: session.participant?.id ?? null,
  });

  if (wasAuthenticated && session.participantsModeEnabled && !session.authenticated) {
    emitAuthenticationRequired();
  }
}

function forgetAuthSession(notify: boolean): void {
  const shouldNotify = notify && participantAuthState === "authenticated";
  participantAuthState = "unauthenticated";
  participantCsrfToken = null;
  participantSessionExpiresAt = null;
  console.debug("[auth] Session state cleared", { state: participantAuthState });
  if (shouldNotify) {
    emitAuthenticationRequired();
  }
}

export function onAuthenticationRequired(listener: () => void): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export function webSocketAuthenticationIsValid(): boolean {
  if (participantAuthState === "disabled") return true;
  if (participantAuthState !== "authenticated") return false;
  return participantSessionExpiresAt === null || participantSessionExpiresAt > Date.now();
}

export function reportWebSocketAuthenticationFailure(): void {
  forgetAuthSession(true);
}

export interface SettingsResponse {
  useSubagents: boolean;
  maxReviewIterations: number;
  autoReviewStrategy: "full_re_review" | "closure_first";
  usageLimitsEnabled: boolean;
  warmupEnabled: boolean;
  qaPipelineEnabled?: boolean;
  githubIssuePrEnabled?: boolean;
  runtimeReadiness: {
    availableRuntimeCount: number;
    runtimeProfileCount: number;
    enabledRuntimeProfileCount: number;
  };
  runtimeDefaults: {
    modules: string[];
    openAiBaseUrlConfigured: boolean;
    codexCliPathConfigured: boolean;
    app: AppRuntimeDefaultsResponse;
  };
}

export interface ProjectWarmupSupport {
  supported: boolean;
  skipReason: string | null;
  workflowKind?: string;
  profileMode?: string;
  runtimeId: string | null;
  providerId: string | null;
  runtimeProfileId: string | null;
  transport: string | null;
  model: string | null;
  selectionSource: string | null;
}

export interface ProjectWarmupSession {
  id: string;
  projectId: string;
  runtimeProfileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: string | null;
  model: string | null;
  status: "creating" | "ready" | "failed" | "cleared" | "expired";
  ttlSeconds: number;
  expiresAt: string;
  remainingSeconds: number;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWarmupResponse {
  enabled: boolean;
  support: ProjectWarmupSupport;
  targets?: ProjectWarmupSupport[];
  warmup: ProjectWarmupSession | null;
  warmups?: ProjectWarmupSession[];
}

export interface PartialProjectWarmupResponse {
  enabled?: boolean;
  support: ProjectWarmupSupport;
  targets?: ProjectWarmupSupport[];
  warmup: ProjectWarmupSession | null;
  warmups?: ProjectWarmupSession[];
  partial: true;
  code: string;
  error: string;
  failedTarget?: string | null;
}

export type CreateProjectWarmupResponse = ProjectWarmupResponse | PartialProjectWarmupResponse;

export interface ClearProjectWarmupResponse {
  success: boolean;
  cleared: number;
}

export interface GitHubProjectState {
  connection: GitHubRepositoryConnection | null;
  issues: GitHubIssueLink[];
}

export interface SendChatMessageResponse {
  conversationId: string;
  sessionId: string | null;
  assistantMessage?: string | null;
  attachments?: ChatMessageAttachment[];
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}

interface ChatSessionRequestContext {
  projectId?: string | null;
  runtimeProfileId?: string | null;
}

function withChatSessionContext(path: string, context?: ChatSessionRequestContext): string {
  if (!context) return path;
  const qs = new URLSearchParams();
  if (context.projectId) qs.set("projectId", context.projectId);
  if (context.runtimeProfileId) qs.set("runtimeProfileId", context.runtimeProfileId);
  const suffix = qs.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function performRequest<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
  csrfToken?: string | null,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const method = (options?.method ?? "GET").toUpperCase();
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${url}`, {
      ...options,
      credentials: "include",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  console.debug("[api] %s %s → %d", method, requestPathForLog(url), res.status);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    let message: string | null = null;
    if (typeof body?.error === "string") {
      message = body.error;
    } else if (typeof body?.message === "string") {
      message = body.message;
    } else if (body?.error && typeof body.error === "object") {
      const issues: unknown[] =
        "issues" in body.error && Array.isArray(body.error.issues)
          ? (body.error.issues as unknown[])
          : [];
      const firstIssue = issues.find(
        (issue: unknown): issue is { message?: unknown } =>
          typeof issue === "object" && issue !== null,
      );
      if (typeof firstIssue?.message === "string") {
        message = firstIssue.message;
      }
    }
    if (!message && body?.fieldErrors && typeof body.fieldErrors === "object") {
      const firstFieldError = Object.values(body.fieldErrors).find(
        (value: unknown): value is string[] => Array.isArray(value) && value.length > 0,
      );
      if (firstFieldError) {
        message = firstFieldError[0] ?? null;
      }
    }
    throw new ApiError(message ?? `HTTP ${res.status}`, res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

async function refreshAuthSession(): Promise<AuthSessionState> {
  if (authSessionRefresh) return authSessionRefresh;
  authSessionRefresh = performRequest<AuthSessionState>(AUTH_SESSION_PATH)
    .then((session) => {
      rememberAuthSession(session);
      return session;
    })
    .finally(() => {
      authSessionRefresh = null;
    });
  return authSessionRefresh;
}

async function request<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowCsrfRetry = true,
): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  const requiresCsrf =
    !SAFE_HTTP_METHODS.has(method) && url !== AUTH_LOGIN_PATH && url !== AUTH_SESSION_PATH;

  if (requiresCsrf && participantAuthState === "unknown") {
    await refreshAuthSession();
  }
  if (requiresCsrf && participantAuthState === "authenticated" && !participantCsrfToken) {
    await refreshAuthSession();
  }

  try {
    return await performRequest<T>(
      url,
      options,
      timeoutMs,
      requiresCsrf ? participantCsrfToken : null,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      apiErrorCode(error) === "invalid_csrf" &&
      requiresCsrf &&
      allowCsrfRetry
    ) {
      await refreshAuthSession();
      return request<T>(url, options, timeoutMs, false);
    }
    if (error instanceof ApiError && error.status === 401 && url !== AUTH_LOGIN_PATH) {
      forgetAuthSession(true);
    }
    throw error;
  }
}

// Task list fetch. projectId is required: the board/list view is always scoped.
// The dashboard moved to GET /projects/overview (see #139), so the bare no-arg
// listTasks() path has no remaining caller and is removed. The server route
// still answers bare requests for backward compatibility, but the web client
// never calls it.
function listTasks(projectId: string): Promise<TaskListItem[]> {
  const qs = `?projectId=${encodeURIComponent(projectId)}`;
  return request<TaskListItem[]>(`${API_BASE}${qs}`);
}

export const api = {
  getAuthSession(): Promise<AuthSessionState> {
    return refreshAuthSession();
  },

  async login(input: { username: string; password: string }): Promise<AuthSessionState> {
    const session = await request<AuthSessionState>(AUTH_LOGIN_PATH, {
      method: "POST",
      body: JSON.stringify(input),
    });
    rememberAuthSession(session);
    return session;
  },

  async logout(): Promise<{ ok: true }> {
    const response = await request<{ ok: true }>("/auth/logout", { method: "POST" });
    forgetAuthSession(false);
    return response;
  },

  changeParticipantPassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true; revokedSessionCount: number }> {
    return request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  listParticipants(includeInactive = true): Promise<Participant[]> {
    return request<Participant[]>(
      `/participants?includeInactive=${includeInactive ? "true" : "false"}`,
    );
  },

  createParticipant(input: CreateParticipantInput): Promise<Participant> {
    return request<Participant>("/participants", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateParticipant(id: string, input: UpdateParticipantInput): Promise<Participant> {
    return request<Participant>(`/participants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  deactivateParticipant(id: string): Promise<Participant> {
    return request<Participant>(`/participants/${encodeURIComponent(id)}/deactivate`, {
      method: "POST",
    });
  },

  resetParticipantPassword(
    id: string,
    input: ResetParticipantPasswordInput,
  ): Promise<{ ok: true; participant: Participant }> {
    return request<{ ok: true; participant: Participant }>(
      `/participants/${encodeURIComponent(id)}/reset-password`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  getSettings(): Promise<SettingsResponse> {
    return request("/settings");
  },

  getAppRuntimeDefaults(): Promise<AppRuntimeDefaultsResponse> {
    return request("/settings/runtime-defaults");
  },

  updateAppRuntimeDefaults(input: {
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  }): Promise<AppRuntimeDefaultsResponse> {
    return request("/settings/runtime-defaults", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  // Projects
  listProjects(): Promise<Project[]> {
    return request<Project[]>("/projects");
  },

  listProjectTaskOverviews(): Promise<ProjectTaskOverview[]> {
    return request<ProjectTaskOverview[]>("/projects/overview");
  },

  createProject(input: CreateProjectInput): Promise<Project> {
    return request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateProject(id: string, input: CreateProjectInput): Promise<Project> {
    return request<Project>(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  updateProjectOrganization(id: string, input: UpdateProjectOrganizationInput): Promise<Project> {
    return request<Project>(`/projects/${encodeURIComponent(id)}/organization`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  getAutoQueueMode(id: string): Promise<{ enabled: boolean }> {
    return request<{ enabled: boolean }>(`/projects/${id}/auto-queue-mode`);
  },

  setAutoQueueMode(id: string, enabled: boolean): Promise<{ enabled: boolean }> {
    return request<{ enabled: boolean }>(`/projects/${id}/auto-queue-mode`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
  },

  deleteProject(id: string): Promise<void> {
    return request(`/projects/${id}`, { method: "DELETE" });
  },

  getProjectDefaults(id: string): Promise<{
    paths: NonNullable<AifConfig["paths"]>;
    workflow: NonNullable<AifConfig["workflow"]>;
  }> {
    return request(`/projects/${id}/defaults`);
  },

  getProjectMcp(id: string): Promise<{ mcpServers: Record<string, unknown> }> {
    return request(`/projects/${id}/mcp`);
  },

  getProjectGitHub(id: string): Promise<GitHubProjectState> {
    return request(`/projects/${encodeURIComponent(id)}/github`);
  },

  connectProjectGitHub(
    id: string,
    input: {
      repository: string;
      tokenEnvVar: string;
      enabled: boolean;
      eligibility: GitHubEligibility;
    },
  ): Promise<GitHubRepositoryConnection> {
    return request(`/projects/${encodeURIComponent(id)}/github`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  disconnectProjectGitHub(id: string): Promise<void> {
    return request(`/projects/${encodeURIComponent(id)}/github`, { method: "DELETE" });
  },

  syncProjectGitHub(id: string): Promise<{
    imported: number;
    updated: number;
    skipped: number;
    issues: GitHubIssueLink[];
  }> {
    return request(`/projects/${encodeURIComponent(id)}/github/sync`, {
      method: "POST",
      body: "{}",
    });
  },

  getProjectWarmup(id: string): Promise<ProjectWarmupResponse> {
    return request<ProjectWarmupResponse>(`/projects/${id}/warmup`);
  },

  createProjectWarmup(
    id: string,
    input: { ttlSeconds?: number },
  ): Promise<CreateProjectWarmupResponse> {
    return request<CreateProjectWarmupResponse>(
      `/projects/${id}/warmup`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      PLAN_FAST_FIX_TIMEOUT_MS,
    );
  },

  clearProjectWarmup(id: string): Promise<ClearProjectWarmupResponse> {
    return request<ClearProjectWarmupResponse>(`/projects/${id}/warmup`, { method: "DELETE" });
  },

  // Tasks
  listTasks,

  getTask(id: string): Promise<Task> {
    return request<Task>(`${API_BASE}/${id}`);
  },

  createTask(input: CreateTaskInput): Promise<Task> {
    return request<Task>(API_BASE, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    return request<Task>(`${API_BASE}/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  handoffTask(
    id: string,
    input: HandoffTaskInput,
  ): Promise<{ task: Task; ownership: TaskOwnership; history: TaskExecutorHistoryEntry }> {
    return request(`${API_BASE}/${encodeURIComponent(id)}/handoff`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getTaskExecutorHistory(id: string): Promise<TaskExecutorHistoryEntry[]> {
    return request(`${API_BASE}/${encodeURIComponent(id)}/executor-history`);
  },

  deleteTask(id: string): Promise<void> {
    return request(`${API_BASE}/${id}`, { method: "DELETE" });
  },

  taskEvent(
    id: string,
    event: TaskEvent,
    options?: Pick<TaskEventInput, "deletePlanFile" | "commitOnApprove">,
  ): Promise<Task> {
    const timeoutMs = event === "fast_fix" ? PLAN_FAST_FIX_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return request<Task>(
      `${API_BASE}/${id}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          event,
          deletePlanFile: options?.deletePlanFile,
          commitOnApprove: options?.commitOnApprove,
        }),
      },
      timeoutMs,
    );
  },

  listTaskComments(id: string): Promise<TaskComment[]> {
    return request<TaskComment[]>(`${API_BASE}/${id}/comments`);
  },

  createTaskComment(id: string, input: CreateTaskCommentInput): Promise<TaskComment> {
    return request<TaskComment>(`${API_BASE}/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  reorderTask(id: string, position: number): Promise<Task> {
    return request<Task>(`${API_BASE}/${id}/position`, {
      method: "PATCH",
      body: JSON.stringify({ position }),
    });
  },

  syncTaskPlan(id: string): Promise<Task> {
    return request<Task>(`${API_BASE}/${id}/sync-plan`, {
      method: "POST",
    });
  },

  getTaskPlanFileStatus(id: string): Promise<{ exists: boolean; path: string }> {
    return request<{ exists: boolean; path: string }>(`${API_BASE}/${id}/plan-file-status`);
  },

  async runQa(id: string): Promise<void> {
    await request<void>(`${API_BASE}/${id}/run-qa`, { method: "POST" });
  },

  checkRoadmapStatus(projectId: string): Promise<{ exists: boolean }> {
    return request<{ exists: boolean }>(`/projects/${projectId}/roadmap/status`);
  },

  importRoadmap(
    projectId: string,
    roadmapAlias: string,
  ): Promise<{
    roadmapAlias: string;
    created: number;
    skipped: number;
    taskIds: string[];
    byPhase: Record<number, { created: number; skipped: number }>;
  }> {
    return request(
      `/projects/${projectId}/roadmap/import`,
      {
        method: "POST",
        body: JSON.stringify({ roadmapAlias }),
      },
      IMPORT_ROADMAP_TIMEOUT_MS,
    );
  },

  generateRoadmap(
    projectId: string,
    roadmapAlias: string,
    vision?: string,
  ): Promise<{ status: string; projectId: string; roadmapAlias: string }> {
    return request(`/projects/${projectId}/roadmap/generate`, {
      method: "POST",
      body: JSON.stringify({ roadmapAlias, vision }),
    });
  },

  getMcpStatus(): Promise<{
    installed: boolean;
    serverName: string;
    runtimes: Array<{ runtimeId: string; installed: boolean; config?: unknown }>;
  }> {
    return request("/settings/mcp");
  },

  installMcp(): Promise<{
    success: boolean;
    serverName: string;
    runtimes: Array<{ runtimeId: string; success: boolean; error?: string }>;
  }> {
    return request("/settings/mcp/install", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  removeMcp(): Promise<{ success: boolean }> {
    return request("/settings/mcp", { method: "DELETE" });
  },

  getConfigStatus(projectId: string): Promise<{ exists: boolean; path: string }> {
    return request(`/settings/config/status?projectId=${encodeURIComponent(projectId)}`);
  },

  getConfig(projectId: string): Promise<{ config: AifConfig }> {
    return request(`/settings/config?projectId=${encodeURIComponent(projectId)}`);
  },

  saveConfig(config: AifConfig, projectId: string): Promise<{ success: boolean }> {
    return request(`/settings/config?projectId=${encodeURIComponent(projectId)}`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
  },

  sendChatMessage(input: ChatRequest): Promise<SendChatMessageResponse> {
    return request<SendChatMessageResponse>(
      "/chat",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      CHAT_TIMEOUT_MS,
    );
  },

  async abortChat(conversationId: string): Promise<void> {
    try {
      await request<void>(`/chat/${conversationId}/abort`, { method: "POST" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  },

  // Chat Sessions
  listChatSessions(projectId: string): Promise<ChatSession[]> {
    return request<ChatSession[]>(`/chat/sessions?projectId=${projectId}`);
  },

  createChatSession(input: CreateChatSessionInput): Promise<ChatSession> {
    return request<ChatSession>("/chat/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getChatSession(id: string, context?: ChatSessionRequestContext): Promise<ChatSession> {
    return request<ChatSession>(withChatSessionContext(`/chat/sessions/${id}`, context));
  },

  getChatSessionMessages(
    sessionId: string,
    context?: ChatSessionRequestContext,
  ): Promise<ChatSessionMessage[]> {
    return request<ChatSessionMessage[]>(
      withChatSessionContext(`/chat/sessions/${sessionId}/messages`, context),
    );
  },

  updateChatSession(id: string, input: UpdateChatSessionInput): Promise<ChatSession> {
    return request<ChatSession>(`/chat/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  deleteChatSession(id: string): Promise<void> {
    return request(`/chat/sessions/${id}`, { method: "DELETE" });
  },

  // Runtime profiles
  listRuntimeProfiles(params?: {
    projectId?: string;
    includeGlobal?: boolean;
    enabledOnly?: boolean;
    scope?: "global" | "project";
  }): Promise<RuntimeProfile[]> {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set("projectId", params.projectId);
    if (params?.includeGlobal !== undefined) qs.set("includeGlobal", String(params.includeGlobal));
    if (params?.enabledOnly !== undefined) qs.set("enabledOnly", String(params.enabledOnly));
    if (params?.scope) qs.set("scope", params.scope);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<RuntimeProfile[]>(`/runtime-profiles${suffix}`);
  },

  listRuntimes(): Promise<RuntimeDescriptor[]> {
    return request("/runtime-profiles/runtimes");
  },

  createRuntimeProfile(input: CreateRuntimeProfileInput): Promise<RuntimeProfile> {
    return request("/runtime-profiles", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateRuntimeProfile(id: string, input: UpdateRuntimeProfileInput): Promise<RuntimeProfile> {
    return request(`/runtime-profiles/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  deleteRuntimeProfile(id: string): Promise<{ success: boolean }> {
    return request(`/runtime-profiles/${id}`, {
      method: "DELETE",
    });
  },

  validateRuntimeProfile(input: {
    projectId?: string;
    profileId?: string;
    profile?: CreateRuntimeProfileInput;
    modelOverride?: string | null;
    runtimeOptions?: Record<string, unknown> | null;
    apiKey?: string;
    forceRefresh?: boolean;
  }): Promise<{
    ok: boolean;
    message: string;
    details: Record<string, unknown> | null;
    profile: Record<string, unknown>;
  }> {
    return request("/runtime-profiles/validate", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  listRuntimeModels(input: {
    projectId?: string;
    profileId?: string;
    profile?: CreateRuntimeProfileInput;
    modelOverride?: string | null;
    runtimeOptions?: Record<string, unknown> | null;
    apiKey?: string;
    forceRefresh?: boolean;
  }): Promise<{
    models: Array<{
      id: string;
      label?: string;
      supportsStreaming?: boolean;
      metadata?: Record<string, unknown>;
    }>;
    profile: Record<string, unknown>;
  }> {
    return request("/runtime-profiles/models", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getEffectiveTaskRuntime(taskId: string): Promise<{
    source: string;
    profile: RuntimeProfile | null;
    taskRuntimeProfileId: string | null;
    projectRuntimeProfileId: string | null;
    systemRuntimeProfileId: string | null;
  }> {
    return request(`/runtime-profiles/effective/task/${taskId}`);
  },

  getEffectiveChatRuntime(projectId: string): Promise<{
    source: string;
    profile: RuntimeProfile | null;
    taskRuntimeProfileId: string | null;
    projectRuntimeProfileId: string | null;
    systemRuntimeProfileId: string | null;
    resolved: {
      source: string;
      profileId: string | null;
      runtimeId: string;
      providerId: string;
      transport: string;
      baseUrl: string | null;
      apiKeyEnvVar: string | null;
      hasApiKey: boolean;
      model: string | null;
      headers: string[];
      optionKeys: string[];
      workflowKind: string | null;
    };
  }> {
    return request(`/runtime-profiles/effective/chat/${projectId}`);
  },

  // Codex login proxy (feature-flagged)
  getCodexLoginCapabilities(): Promise<{ loginProxyEnabled: boolean }> {
    return request("/auth/codex/capabilities");
  },

  getCodexLoginStatus(): Promise<
    | {
        active: true;
        sessionId: string;
        verificationUrl: string;
        userCode: string;
        startedAt: string;
      }
    | {
        active: false;
        lastResult?: {
          ok: boolean;
          sessionId: string;
          reason:
            | "success"
            | "exit_nonzero"
            | "signal"
            | "timeout"
            | "parse_timeout"
            | "cancel"
            | "spawn_failed";
          exitCode: number | null;
          signal: string | null;
          finishedAt: string;
        };
      }
  > {
    return request("/auth/codex/login/status");
  },

  startCodexLogin(): Promise<{
    sessionId: string;
    verificationUrl: string;
    userCode: string;
    startedAt: string;
  }> {
    return request("/auth/codex/login/start", { method: "POST" }, PLAN_FAST_FIX_TIMEOUT_MS);
  },

  cancelCodexLogin(): Promise<{ ok: boolean; cancelled: boolean }> {
    return request("/auth/codex/login/cancel", { method: "POST" });
  },
};
