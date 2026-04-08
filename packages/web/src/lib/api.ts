import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskEventInput,
  TaskComment,
  CreateTaskCommentInput,
  Project,
  CreateProjectInput,
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
} from "@aif/shared/browser";

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

const API_PREFIX = import.meta.env.DEV ? "" : "/api";
const API_BASE = "/tasks";
const REQUEST_TIMEOUT_MS = 15000;
const FAST_FIX_TIMEOUT_MS = 120000;

export interface SettingsResponse {
  useSubagents: boolean;
  maxReviewIterations: number;
  runtimeReadiness: {
    availableRuntimeCount: number;
    runtimeProfileCount: number;
    enabledRuntimeProfileCount: number;
  };
  runtimeDefaults: {
    modules: string[];
    openAiBaseUrlConfigured: boolean;
    codexCliPathConfigured: boolean;
  };
}

async function request<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${url}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
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
    throw new Error(message ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  getSettings(): Promise<SettingsResponse> {
    console.debug("[api] GET /settings");
    return request("/settings");
  },

  // Projects
  listProjects(): Promise<Project[]> {
    console.debug("[api] GET /projects");
    return request<Project[]>("/projects");
  },

  createProject(input: CreateProjectInput): Promise<Project> {
    console.debug("[api] POST /projects", input);
    return request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateProject(id: string, input: CreateProjectInput): Promise<Project> {
    console.debug("[api] PUT /projects/%s", id, input);
    return request<Project>(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  deleteProject(id: string): Promise<void> {
    console.debug("[api] DELETE /projects/%s", id);
    return request(`/projects/${id}`, { method: "DELETE" });
  },

  getProjectDefaults(id: string): Promise<{
    paths: NonNullable<AifConfig["paths"]>;
    workflow: NonNullable<AifConfig["workflow"]>;
  }> {
    return request(`/projects/${id}/defaults`);
  },

  getProjectMcp(id: string): Promise<{ mcpServers: Record<string, unknown> }> {
    console.debug("[api] GET /projects/%s/mcp", id);
    return request(`/projects/${id}/mcp`);
  },

  // Tasks
  listTasks(projectId?: string): Promise<Task[]> {
    const qs = projectId ? `?projectId=${projectId}` : "";
    console.debug("[api] GET /tasks%s", qs);
    return request<Task[]>(`${API_BASE}${qs}`);
  },

  getTask(id: string): Promise<Task> {
    console.debug("[api] GET /tasks/%s", id);
    return request<Task>(`${API_BASE}/${id}`);
  },

  createTask(input: CreateTaskInput): Promise<Task> {
    console.debug("[api] POST /tasks", input);
    return request<Task>(API_BASE, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    console.debug("[api] PUT /tasks/%s", id, input);
    return request<Task>(`${API_BASE}/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  deleteTask(id: string): Promise<void> {
    console.debug("[api] DELETE /tasks/%s", id);
    return request(`${API_BASE}/${id}`, { method: "DELETE" });
  },

  taskEvent(
    id: string,
    event: TaskEvent,
    options?: Pick<TaskEventInput, "deletePlanFile" | "commitOnApprove">,
  ): Promise<Task> {
    console.debug("[api] POST /tasks/%s/events →", id, event);
    const timeoutMs = event === "fast_fix" ? FAST_FIX_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
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
    console.debug("[api] GET /tasks/%s/comments", id);
    return request<TaskComment[]>(`${API_BASE}/${id}/comments`);
  },

  createTaskComment(id: string, input: CreateTaskCommentInput): Promise<TaskComment> {
    console.debug("[api] POST /tasks/%s/comments", id, input);
    return request<TaskComment>(`${API_BASE}/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  reorderTask(id: string, position: number): Promise<Task> {
    console.debug("[api] PATCH /tasks/%s/position →", id, position);
    return request<Task>(`${API_BASE}/${id}/position`, {
      method: "PATCH",
      body: JSON.stringify({ position }),
    });
  },

  syncTaskPlan(id: string): Promise<Task> {
    console.debug("[api] POST /tasks/%s/sync-plan", id);
    return request<Task>(`${API_BASE}/${id}/sync-plan`, {
      method: "POST",
    });
  },

  getTaskPlanFileStatus(id: string): Promise<{ exists: boolean; path: string }> {
    console.debug("[api] GET /tasks/%s/plan-file-status", id);
    return request<{ exists: boolean; path: string }>(`${API_BASE}/${id}/plan-file-status`);
  },

  checkRoadmapStatus(projectId: string): Promise<{ exists: boolean }> {
    console.debug("[api] GET /projects/%s/roadmap/status", projectId);
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
    console.debug("[api] POST /projects/%s/roadmap/import", projectId, { roadmapAlias });
    return request(
      `/projects/${projectId}/roadmap/import`,
      {
        method: "POST",
        body: JSON.stringify({ roadmapAlias }),
      },
      120000,
    );
  },

  generateRoadmap(
    projectId: string,
    roadmapAlias: string,
    vision?: string,
  ): Promise<{ status: string; projectId: string; roadmapAlias: string }> {
    console.debug("[api] POST /projects/%s/roadmap/generate", projectId, {
      roadmapAlias,
      vision,
    });
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

  sendChatMessage(input: ChatRequest): Promise<{
    conversationId: string;
    sessionId: string | null;
    attachments?: ChatMessageAttachment[];
  }> {
    console.debug("[api] POST /chat", {
      projectId: input.projectId,
      explore: input.explore,
      sessionId: input.sessionId,
    });
    return request<{
      conversationId: string;
      sessionId: string | null;
      attachments?: ChatMessageAttachment[];
    }>(
      "/chat",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      120000,
    );
  },

  // Chat Sessions
  listChatSessions(projectId: string): Promise<ChatSession[]> {
    console.debug("[api] GET /chat/sessions projectId=%s", projectId);
    return request<ChatSession[]>(`/chat/sessions?projectId=${projectId}`);
  },

  createChatSession(input: CreateChatSessionInput): Promise<ChatSession> {
    console.debug("[api] POST /chat/sessions", input);
    return request<ChatSession>("/chat/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getChatSession(id: string): Promise<ChatSession> {
    console.debug("[api] GET /chat/sessions/%s", id);
    return request<ChatSession>(`/chat/sessions/${id}`);
  },

  getChatSessionMessages(sessionId: string): Promise<ChatSessionMessage[]> {
    console.debug("[api] GET /chat/sessions/%s/messages", sessionId);
    return request<ChatSessionMessage[]>(`/chat/sessions/${sessionId}/messages`);
  },

  updateChatSession(id: string, input: UpdateChatSessionInput): Promise<ChatSession> {
    console.debug("[api] PUT /chat/sessions/%s", id, input);
    return request<ChatSession>(`/chat/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  deleteChatSession(id: string): Promise<void> {
    console.debug("[api] DELETE /chat/sessions/%s", id);
    return request(`/chat/sessions/${id}`, { method: "DELETE" });
  },

  // Runtime profiles
  listRuntimeProfiles(params?: {
    projectId?: string;
    includeGlobal?: boolean;
    enabledOnly?: boolean;
  }): Promise<RuntimeProfile[]> {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set("projectId", params.projectId);
    if (params?.includeGlobal !== undefined) qs.set("includeGlobal", String(params.includeGlobal));
    if (params?.enabledOnly !== undefined) qs.set("enabledOnly", String(params.enabledOnly));
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
};
