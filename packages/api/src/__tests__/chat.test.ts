import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RuntimeExecutionError, type RuntimeAdapter, type RuntimeRunInput } from "@aif/runtime";
import { resetEnvCache } from "@aif/shared";

// Flag defaults to false (opt-in). These tests assert on runtime limit
// snapshots being emitted to chat responses, which needs the gate open.
process.env.AIF_USAGE_LIMITS_ENABLED = "true";
resetEnvCache();

const mockFindProjectById = vi.fn();
const mockFindTaskById = vi.fn();
const mockToTaskResponse = vi.fn();
const mockCreateChatSession = vi.fn();
const mockFindChatSessionById = vi.fn();
const mockUpdateChatSession = vi.fn();
const mockCreateChatMessage = vi.fn();
const mockUpdateChatSessionTimestamp = vi.fn();
const mockListChatMessages = vi.fn();
const mockToChatMessageResponse = vi.fn();
const mockSendToClient = vi.fn();
const mockBroadcast = vi.fn();
const mockInvalidateCache = vi.fn();
const mockResolveApiRuntimeContext = vi.fn();
const mockAssertApiRuntimeCapabilities = vi.fn();
const mockGetApiRuntimeRegistry = vi.fn();
const mockPersistAttachments = vi.fn();
const mockRefreshRuntimeProfileLimitState = vi.fn();

const mockAdapterRun = vi.fn();
const mockAdapterResume = vi.fn();
const mockListSessionEvents = vi.fn();

const runtimeAdapter: RuntimeAdapter = {
  descriptor: {
    id: "claude",
    providerId: "anthropic",
    displayName: "Claude",
    defaultTransport: "sdk",
    capabilities: {
      supportsResume: true,
      supportsSessionList: true,
      supportsAgentDefinitions: true,
      supportsStreaming: true,
      supportsModelDiscovery: true,
      supportsApprovals: true,
      supportsCustomEndpoint: true,
      usageReporting: "full",
    },
  },
  run: (input) => mockAdapterRun(input),
  resume: (input) => mockAdapterResume(input),
  listSessionEvents: (input) => mockListSessionEvents(input),
};

vi.mock("@aif/data", () => ({
  findProjectById: (id: string) => mockFindProjectById(id),
  findTaskById: (id: string) => mockFindTaskById(id),
  toTaskResponse: (task: unknown) => mockToTaskResponse(task),
  createChatSession: (input: unknown) => mockCreateChatSession(input),
  findChatSessionById: (id: string) => mockFindChatSessionById(id),
  updateChatSession: (id: string, input: unknown) => mockUpdateChatSession(id, input),
  createChatMessage: (input: unknown) => mockCreateChatMessage(input),
  updateChatSessionTimestamp: (id: string) => mockUpdateChatSessionTimestamp(id),
  listChatSessions: vi.fn(() => []),
  listCodexSessionsByProjectRoot: vi.fn(() => []),
  findCodexSessionFilePathBySessionId: vi.fn(() => null),
  listChatMessages: (...args: unknown[]) => mockListChatMessages(...args),
  toChatSessionResponse: vi.fn((row: unknown) => row),
  toChatMessageResponse: (row: unknown) => mockToChatMessageResponse(row),
  deleteChatSession: vi.fn(),
  findRuntimeProfileById: vi.fn(() => null),
  createDbUsageSink: () => ({ record: vi.fn() }),
}));

vi.mock("../services/runtime.js", () => ({
  resolveApiRuntimeContext: (input: unknown) => mockResolveApiRuntimeContext(input),
  assertApiRuntimeCapabilities: (input: unknown) => mockAssertApiRuntimeCapabilities(input),
  getApiRuntimeRegistry: () => mockGetApiRuntimeRegistry(),
  observeRuntimeLimitEvent: (
    event: { type: string; data?: Record<string, unknown> },
    current: unknown,
  ) => (event.type === "runtime:limit" ? (event.data?.snapshot ?? current) : current),
  extractLatestRuntimeLimitSnapshot: (
    events: Array<{ type: string; data?: Record<string, unknown> }> | null | undefined,
  ) => {
    if (!events?.length) return null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "runtime:limit") {
        return event.data?.snapshot ?? null;
      }
    }
    return null;
  },
  extractRuntimeLimitSnapshotFromError: (error: unknown) =>
    error instanceof RuntimeExecutionError ? (error.limitSnapshot ?? null) : null,
  refreshRuntimeProfileLimitState: (...args: unknown[]) =>
    mockRefreshRuntimeProfileLimitState(...args),
}));

vi.mock("../services/attachmentPersistence.js", () => ({
  persistAttachments: (...args: unknown[]) => mockPersistAttachments(...args),
}));

vi.mock("../ws.js", () => ({
  sendToClient: (...args: unknown[]) => mockSendToClient(...args),
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock("../services/sessionCache.js", () => ({
  getCached: vi.fn(() => undefined),
  setCached: vi.fn(),
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
  invalidateAllSessionCaches: vi.fn(),
  sessionCacheKey: vi.fn(() => "runtime-cache-key"),
  shouldUseSessionCacheForRuntime: vi.fn(() => true),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      AGENT_BYPASS_PERMISSIONS: false,
      API_RUNTIME_START_TIMEOUT_MS: 600_000,
      API_RUNTIME_RUN_TIMEOUT_MS: 600_000,
      AGENT_CHAT_MAX_TURNS: 50,
      AIF_DEFAULT_RUNTIME_ID: "claude",
      AIF_DEFAULT_PROVIDER_ID: "anthropic",
      AIF_USAGE_LIMITS_ENABLED: true,
    }),
  };
});

const { chatRouter } = await import("../routes/chat.js");

function createApp() {
  const app = new Hono();
  app.route("/chat", chatRouter);
  return app;
}

describe("chat API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();

    mockFindProjectById.mockReturnValue({
      id: "project-1",
      rootPath: "/tmp/project-1",
      name: "Test Project",
    });

    mockCreateChatSession.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Test",
      runtimeProfileId: null,
      runtimeSessionId: null,
    });

    mockFindChatSessionById.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Test",
      runtimeProfileId: null,
      runtimeSessionId: null,
      agentSessionId: null,
    });

    mockResolveApiRuntimeContext.mockResolvedValue({
      project: { id: "project-1", rootPath: "/tmp/project-1" },
      adapter: runtimeAdapter,
      resolvedProfile: {
        source: "project_default",
        profileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyEnvVar: null,
        headers: {},
        options: {},
      },
      selectionSource: "project_default",
    });

    mockAdapterRun.mockResolvedValue({
      outputText: "runtime output",
      sessionId: "runtime-session-1",
    });
    mockAdapterResume.mockResolvedValue({
      outputText: "resumed output",
      sessionId: "runtime-session-1",
    });
    mockListSessionEvents.mockResolvedValue([]);
    mockPersistAttachments.mockResolvedValue([]);
    mockListChatMessages.mockReturnValue([]);
    mockToChatMessageResponse.mockImplementation((row) => row);
    mockListSessionEvents.mockResolvedValue([]);
    mockGetApiRuntimeRegistry.mockResolvedValue({
      resolveRuntime: vi.fn(() => runtimeAdapter),
    });
  });

  it("returns 404 when project is not found", async () => {
    mockFindProjectById.mockReturnValueOnce(undefined);

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "missing",
        message: "hello",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
    expect(mockAdapterRun).not.toHaveBeenCalled();
  });

  it("streams runtime events and sends done", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({ type: "stream:text", message: "Hello " });
      onEvent?.({ type: "stream:text", message: "world" });
      onEvent?.({ type: "tool:summary", message: "Read 3 files" });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain prompt",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.conversationId).toBe("string");
    expect(body.sessionId).toBe("session-1");

    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    expect(tokenCalls.length).toBeGreaterThanOrEqual(3);
    expect(tokenCalls[0][1].payload.token).toBe("Hello ");
    expect(tokenCalls[1][1].payload.token).toBe("world");
    expect(tokenCalls.some((call) => String(call[1].payload.token).includes("Read 3 files"))).toBe(
      true,
    );
    expect(mockSendToClient).toHaveBeenCalledWith(
      "client-1",
      expect.objectContaining({ type: "chat:done" }),
    );
  });

  it("preserves runtime limit state after successful chat runs without snapshots", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain prompt",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockRefreshRuntimeProfileLimitState).not.toHaveBeenCalled();
  });

  it("returns assistant text in HTTP response when websocket clientId is absent", async () => {
    mockAdapterRun.mockResolvedValueOnce({
      outputText: "runtime output without ws",
      sessionId: "runtime-session-1",
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain prompt",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        assistantMessage: "runtime output without ws",
      }),
    );
    expect(mockSendToClient).not.toHaveBeenCalled();
  });

  it("normalizes runtime limit snapshots before emitting chat:done and HTTP success payloads", async () => {
    mockAdapterRun.mockImplementationOnce(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "runtime:limit",
        data: {
          snapshot: {
            source: "provider_api",
            status: "warning",
            precision: "exact",
            checkedAt: "2026-04-19T10:00:00.000Z",
            providerId: "anthropic",
            runtimeId: "claude",
            profileId: "profile-1",
            primaryScope: "tool_usage",
            resetAt: "2026-04-19T11:00:00.000Z",
            retryAfterSeconds: null,
            warningThreshold: 10,
            windows: [
              {
                scope: "tool_usage",
                percentRemaining: 7,
                warningThreshold: 10,
                resetAt: "2026-04-19T11:00:00.000Z",
              },
            ],
            providerMeta: {
              providerLabel: "Z.AI GLM Coding Plan",
              quotaSource: "zai_monitor",
              accountLabel: "Anton Ageev Pro",
              usageDetails: [{ token: "sk-SECRET" }],
              headers: { authorization: "Bearer secret" },
              accountEmail: "private@example.com",
            },
          },
        },
      });
      return { outputText: "runtime output", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain prompt",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimeLimitSnapshot).toEqual(
      expect.objectContaining({
        status: "warning",
        providerMeta: {
          providerLabel: "Z.AI GLM Coding Plan",
          quotaSource: "zai_monitor",
        },
      }),
    );
    expect(body.runtimeLimitSnapshot.providerMeta).not.toHaveProperty("usageDetails");
    expect(body.runtimeLimitSnapshot.providerMeta).not.toHaveProperty("headers");
    expect(body.runtimeLimitSnapshot.providerMeta).not.toHaveProperty("accountEmail");

    const doneCall = mockSendToClient.mock.calls.find((call) => call[1]?.type === "chat:done");
    expect(doneCall?.[1]?.payload?.runtimeLimitSnapshot).toEqual(body.runtimeLimitSnapshot);
  });

  it("uses adapter.resume and prefixes prompt with /aif-explore", async () => {
    mockFindChatSessionById.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Test",
      runtimeProfileId: null,
      runtimeSessionId: "runtime-session-prev",
      agentSessionId: null,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "investigate this",
        clientId: "client-1",
        sessionId: "session-1",
        explore: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockAdapterResume).toHaveBeenCalledTimes(1);
    const resumeInput = mockAdapterResume.mock.calls[0][0] as RuntimeRunInput;
    expect(resumeInput.prompt).toContain("/aif-explore investigate this");
    expect(resumeInput.sessionId).toBe("runtime-session-prev");
    expect(mockCreateChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        role: "assistant",
        content: "resumed output",
      }),
    );
  });

  it("pins resumed chat runs to the saved session runtime profile", async () => {
    mockFindChatSessionById.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Pinned",
      runtimeProfileId: "profile-pinned",
      runtimeSessionId: "runtime-session-prev",
      agentSessionId: null,
    });
    mockResolveApiRuntimeContext.mockImplementation(async (input: Record<string, unknown>) => ({
      project: { id: "project-1", rootPath: "/tmp/project-1" },
      adapter: runtimeAdapter,
      resolvedProfile: {
        source: input.runtimeProfileId ? "profile_id" : "project_default",
        profileId: (input.runtimeProfileId as string | undefined) ?? "profile-default",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyEnvVar: null,
        headers: {},
        options: {},
      },
      selectionSource: input.runtimeProfileId ? "profile_id" : "project_default",
    }));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "resume pinned session",
        sessionId: "session-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockResolveApiRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        mode: "chat",
        runtimeProfileId: "profile-pinned",
      }),
    );
    expect(mockAdapterResume).toHaveBeenCalledTimes(1);
    expect(mockUpdateChatSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        runtimeProfileId: "profile-pinned",
        runtimeSessionId: "runtime-session-1",
      }),
    );
  });

  it("passes chat execution timeouts from env", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain prompt",
      }),
    });

    expect(res.status).toBe(200);
    const runInput = mockAdapterRun.mock.calls[0]?.[0] as RuntimeRunInput;
    expect(runInput.execution).toEqual(
      expect.objectContaining({
        startTimeoutMs: 600_000,
        runTimeoutMs: 600_000,
        maxTurns: 50,
      }),
    );
  });

  it("returns 429 and emits chat:error for usage-limit failures", async () => {
    mockAdapterRun.mockRejectedValue(
      new RuntimeExecutionError("You're out of extra usage", undefined, "rate_limit"),
    );

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "hello",
        clientId: "client-1",
        conversationId: "conv-limit-1",
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("CHAT_USAGE_LIMIT");
    expect(body.error).toBe("Runtime usage limit reached. Try again later.");
    expect(mockSendToClient).toHaveBeenCalledWith(
      "client-1",
      expect.objectContaining({
        type: "chat:error",
        payload: expect.objectContaining({
          conversationId: "conv-limit-1",
          code: "CHAT_USAGE_LIMIT",
          message: "Runtime usage limit reached. Try again later.",
        }),
      }),
    );
  });

  it("normalizes runtime limit snapshots before emitting chat:error and HTTP error payloads", async () => {
    mockAdapterRun.mockRejectedValueOnce(
      new RuntimeExecutionError("You're out of extra usage", undefined, "rate_limit", {
        limitSnapshot: {
          source: "provider_api",
          status: "blocked",
          precision: "exact",
          checkedAt: "2026-04-19T10:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-1",
          primaryScope: "tool_usage",
          resetAt: "2026-04-19T11:00:00.000Z",
          retryAfterSeconds: null,
          warningThreshold: 10,
          windows: [
            {
              scope: "tool_usage",
              percentRemaining: 0,
              warningThreshold: 10,
              resetAt: "2026-04-19T11:00:00.000Z",
            },
          ],
          providerMeta: {
            providerLabel: "Z.AI GLM Coding Plan",
            quotaSource: "zai_monitor",
            accountLabel: "Anton Ageev Pro",
            usageDetails: [{ token: "sk-SECRET" }],
            diagnostics: "Bearer secret",
          },
        },
      }),
    );

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "hello",
        clientId: "client-1",
        conversationId: "conv-limit-sanitized",
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.runtimeLimitSnapshot).toEqual(
      expect.objectContaining({
        status: "blocked",
        providerMeta: {
          providerLabel: "Z.AI GLM Coding Plan",
          quotaSource: "zai_monitor",
        },
      }),
    );
    expect(body.runtimeLimitSnapshot.providerMeta).not.toHaveProperty("usageDetails");
    expect(body.runtimeLimitSnapshot.providerMeta).not.toHaveProperty("diagnostics");

    const errorCall = mockSendToClient.mock.calls.find((call) => call[1]?.type === "chat:error");
    expect(errorCall?.[1]?.payload).toEqual(
      expect.objectContaining({
        conversationId: "conv-limit-sanitized",
        runtimeLimitSnapshot: body.runtimeLimitSnapshot,
      }),
    );
  });

  it("returns 500 with a sanitized message for non-limit failures", async () => {
    mockAdapterRun.mockRejectedValue(
      new Error('upstream body leaked secret "token=abc123" <script>alert(1)</script>'),
    );

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "hello",
        clientId: "client-1",
        conversationId: "conv-error-1",
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "Chat request failed",
      code: "CHAT_REQUEST_FAILED",
    });
    expect(mockSendToClient).toHaveBeenCalledWith(
      "client-1",
      expect.objectContaining({
        type: "chat:error",
        payload: expect.objectContaining({
          conversationId: "conv-error-1",
          code: "CHAT_REQUEST_FAILED",
          message: "Chat request failed",
        }),
      }),
    );
  });

  it("falls back to generic message when error has no message", async () => {
    mockAdapterRun.mockRejectedValue(new Error(""));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "hello",
        clientId: "client-1",
        conversationId: "conv-error-2",
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "Chat request failed",
      code: "CHAT_REQUEST_FAILED",
    });
  });

  it("includes task context in workflow system append when taskId is provided", async () => {
    mockFindTaskById.mockReturnValue({ id: "task-1", title: "Fix bug", status: "implementing" });
    mockToTaskResponse.mockReturnValue({
      id: "task-1",
      title: "Fix bug",
      status: "implementing",
      description: "Bug details",
      plan: null,
      implementationLog: null,
      reviewComments: null,
      agentActivityLog: null,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "what is this task?",
        clientId: "client-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockFindTaskById).toHaveBeenCalledWith("task-1");
    const resolveCall = mockResolveApiRuntimeContext.mock.calls[0][0] as {
      workflow: { promptInput: { systemPromptAppend?: string } };
    };
    expect(resolveCall.workflow.promptInput.systemPromptAppend).toContain("Fix bug");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).toContain("implementing");
  });

  it("redacts legacy agent activity log secrets before injecting task-aware chat context", async () => {
    mockFindTaskById.mockReturnValue({ id: "task-1", title: "Fix bug", status: "implementing" });
    mockToTaskResponse.mockReturnValue({
      id: "task-1",
      title: "Fix bug",
      status: "implementing",
      description: "Bug details",
      plan: null,
      implementationLog: null,
      reviewComments: null,
      agentActivityLog: "[2026-01-01] Agent: bearer SECRET\n[2026-01-01] Agent: sk-SECRET",
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "what leaked before?",
        clientId: "client-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    const resolveCall = mockResolveApiRuntimeContext.mock.calls[0][0] as {
      workflow: { promptInput: { systemPromptAppend?: string } };
    };
    expect(resolveCall.workflow.promptInput.systemPromptAppend).toContain("[REDACTED]");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("SECRET");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("sk-SECRET");
  });

  it("redacts implementation and review text before injecting task-aware chat context", async () => {
    mockFindTaskById.mockReturnValue({ id: "task-1", title: "Fix bug", status: "implementing" });
    mockToTaskResponse.mockReturnValue({
      id: "task-1",
      title: "Fix bug",
      status: "implementing",
      description: "Internal URL https://internal.local",
      plan: 'oauth access_token="abc123"',
      implementationLog: "Bearer SECRET",
      reviewComments: "client_secret=secret-value",
      agentActivityLog: null,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "what leaked before?",
        clientId: "client-1",
        taskId: "task-1",
      }),
    });

    expect(res.status).toBe(200);
    const resolveCall = mockResolveApiRuntimeContext.mock.calls[0][0] as {
      workflow: { promptInput: { systemPromptAppend?: string } };
    };
    expect(resolveCall.workflow.promptInput.systemPromptAppend).toContain("[REDACTED]");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("SECRET");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("internal.local");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("abc123");
    expect(resolveCall.workflow.promptInput.systemPromptAppend).not.toContain("secret-value");
  });

  it("does not persist incidental runtime limit events when a non-limit runtime error follows", async () => {
    const incidentalSnapshot = {
      source: "sdk_event",
      status: "warning",
      precision: "exact",
      checkedAt: "2026-04-19T10:00:00.000Z",
      providerId: "anthropic",
      runtimeId: "claude",
      profileId: "profile-1",
      primaryScope: "time",
      resetAt: "2026-04-19T11:00:00.000Z",
      retryAfterSeconds: null,
      warningThreshold: 10,
      windows: [
        {
          scope: "time",
          percentRemaining: 4,
          warningThreshold: 10,
          resetAt: "2026-04-19T11:00:00.000Z",
        },
      ],
      providerMeta: null,
    };

    mockAdapterRun.mockImplementationOnce(async (input: RuntimeRunInput) => {
      input.execution?.onEvent?.({
        type: "runtime:limit",
        timestamp: "2026-04-19T10:00:01.000Z",
        data: { snapshot: incidentalSnapshot },
      });
      throw new RuntimeExecutionError("Model missing", undefined, "model_not_found");
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "hello",
        clientId: "client-1",
        conversationId: "conv-incidental-limit",
      }),
    });

    expect(res.status).toBe(500);
    expect(mockRefreshRuntimeProfileLimitState).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "chat:error",
        snapshot: null,
      }),
    );
  });

  it("returns persisted DB messages when linked runtime history is empty", async () => {
    mockFindChatSessionById.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Test",
      runtimeProfileId: null,
      runtimeSessionId: "runtime-session-1",
      agentSessionId: null,
    });
    mockListChatMessages.mockReturnValue([
      {
        id: "msg-1",
        sessionId: "session-1",
        role: "user",
        content: "Saved question",
        createdAt: "2026-04-08T17:00:00.000Z",
      },
      {
        id: "msg-2",
        sessionId: "session-1",
        role: "assistant",
        content: "Saved answer",
        createdAt: "2026-04-08T17:00:01.000Z",
      },
    ]);

    const res = await app.request("/chat/sessions/session-1/messages");

    expect(res.status).toBe(200);
    expect(mockListSessionEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "claude",
        sessionId: "runtime-session-1",
      }),
    );
    expect(await res.json()).toEqual([
      {
        id: "msg-1",
        sessionId: "session-1",
        role: "user",
        content: "Saved question",
        createdAt: "2026-04-08T17:00:00.000Z",
      },
      {
        id: "msg-2",
        sessionId: "session-1",
        role: "assistant",
        content: "Saved answer",
        createdAt: "2026-04-08T17:00:01.000Z",
      },
    ]);
  });

  it("preserves duplicate DB messages that are absent from runtime history", async () => {
    mockFindChatSessionById.mockReturnValue({
      id: "session-1",
      projectId: "project-1",
      title: "Test",
      runtimeProfileId: null,
      runtimeSessionId: "runtime-session-1",
      agentSessionId: null,
    });
    mockListSessionEvents.mockResolvedValue([
      {
        type: "session-message",
        timestamp: "2026-04-08T17:00:05.000Z",
        message: "Saved question",
        data: {
          role: "user",
          id: "runtime-msg-1",
        },
      },
    ]);
    mockListChatMessages.mockReturnValue([
      {
        id: "msg-1",
        sessionId: "session-1",
        role: "user",
        content: "Saved question",
        createdAt: "2026-04-08T17:00:00.000Z",
      },
      {
        id: "msg-2",
        sessionId: "session-1",
        role: "assistant",
        content: "Repeated answer",
        createdAt: "2026-04-08T17:00:01.000Z",
      },
      {
        id: "msg-3",
        sessionId: "session-1",
        role: "assistant",
        content: "Repeated answer",
        createdAt: "2026-04-08T17:00:02.000Z",
      },
    ]);

    const res = await app.request("/chat/sessions/session-1/messages");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(3);
    expect(body.map((message: { content: string; createdAt: string }) => message.content)).toEqual([
      "Saved question",
      "Repeated answer",
      "Repeated answer",
    ]);
    expect(
      body.filter(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Repeated answer",
      ),
    ).toHaveLength(2);
  });
  it("persists incoming chat attachments and stores user message with attachment metadata", async () => {
    mockPersistAttachments.mockResolvedValue([
      {
        name: "plan.md",
        mimeType: "text/markdown",
        size: 12,
        path: "storage/chat/s1/plan.md",
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 4,
        path: null,
      },
    ]);

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "please review attachments",
        clientId: "client-1",
        attachments: [
          { name: "plan.md", mimeType: "text/markdown", size: 12, content: "hello world" },
          { name: "notes.txt", mimeType: "text/plain", size: 4, content: "note" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockPersistAttachments).toHaveBeenCalledTimes(1);
    const runInput = mockAdapterRun.mock.calls[0]?.[0] as RuntimeRunInput;
    expect(runInput.prompt).toContain("Attached files:");
    expect(runInput.prompt).toContain("plan.md");
    expect(mockCreateChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: "please review attachments",
        attachments: [
          {
            name: "plan.md",
            mimeType: "text/markdown",
            size: 12,
            path: "storage/chat/s1/plan.md",
          },
        ],
      }),
    );
  });

  it("returns 404 when aborting an unknown conversation", async () => {
    const res = await app.request("/chat/unknown-conversation-id/abort", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("aborts an in-flight chat run and surfaces chat:error with code 'aborted'", async () => {
    let capturedController: AbortController | undefined;
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      capturedController = input.execution?.abortController;
      if (capturedController?.signal.aborted) {
        const err = new Error("The operation was aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }
      // Simulate adapter honoring the AbortController by throwing AbortError
      await new Promise<void>((_resolve, reject) => {
        capturedController?.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });
    let releaseRuntimeResolutionGate = () => {};
    const runtimeResolutionGate = new Promise<void>((resolve) => {
      releaseRuntimeResolutionGate = () => resolve();
    });
    mockResolveApiRuntimeContext.mockImplementationOnce(async () => {
      await runtimeResolutionGate;
      return {
        project: { id: "project-1", rootPath: "/tmp/project-1" },
        adapter: runtimeAdapter,
        resolvedProfile: {
          source: "project_default",
          profileId: "profile-1",
          runtimeId: "claude",
          providerId: "anthropic",
          transport: "sdk",
          model: null,
          baseUrl: null,
          apiKey: null,
          apiKeyEnvVar: null,
          headers: {},
          options: {},
        },
        selectionSource: "project_default",
      };
    });

    const conversationId = crypto.randomUUID();
    const chatPromise = app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "long task",
        clientId: "client-1",
        conversationId,
      }),
    });

    await Promise.resolve();
    let abortRes: Response | null = null;
    for (let i = 0; i < 50; i += 1) {
      const attempt = await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
      if (attempt.status === 204) {
        abortRes = attempt;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    if (!abortRes) {
      abortRes = await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
    }
    expect(abortRes.status).toBe(204);
    expect(mockCreateChatSession).not.toHaveBeenCalled();

    releaseRuntimeResolutionGate();

    const chatRes = await chatPromise;
    expect(chatRes.status).toBe(409);
    const body = await chatRes.json();
    expect(body.code).toBe("aborted");
    expect(typeof body.sessionId === "string" || body.sessionId === null).toBe(true);
    expect(body.conversationId).toBe(conversationId);

    expect(
      mockSendToClient.mock.calls.some(
        (call) => call[1]?.type === "chat:error" && call[1].payload?.code === "aborted",
      ),
    ).toBe(true);
  });

  it("persists partial streamed output when a run is aborted mid-stream", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      input.execution?.onEvent?.({
        type: "stream:text",
        message: "Partial reply",
        timestamp: new Date().toISOString(),
      });
      await new Promise<void>((_resolve, reject) => {
        input.execution?.abortController?.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
      return { outputText: "", sessionId: "runtime-session-2" };
    });

    const conversationId = crypto.randomUUID();
    const chatPromise = app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "long task",
        clientId: "client-1",
        conversationId,
      }),
    });

    await new Promise((r) => setTimeout(r, 20));
    await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
    const chatRes = await chatPromise;
    expect(chatRes.status).toBe(409);

    expect(
      mockCreateChatMessage.mock.calls.some(
        (call) => call[0]?.role === "assistant" && call[0].content === "Partial reply",
      ),
    ).toBe(true);

    const body = await chatRes.json();
    expect(body.assistantMessage).toBe("Partial reply");
  });

  it("returns saved attachments in the 409 abort response", async () => {
    mockPersistAttachments.mockResolvedValue([
      {
        name: "spec.md",
        mimeType: "text/markdown",
        size: 10,
        path: "storage/chat/s1/spec.md",
      },
    ]);
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      await new Promise<void>((_resolve, reject) => {
        input.execution?.abortController?.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
      return { outputText: "", sessionId: "runtime-session-3" };
    });

    const conversationId = crypto.randomUUID();
    const chatPromise = app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "review this",
        clientId: "client-1",
        conversationId,
        attachments: [{ name: "spec.md", mimeType: "text/markdown", size: 10, content: "hi" }],
      }),
    });

    await new Promise((r) => setTimeout(r, 20));
    await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
    const chatRes = await chatPromise;
    expect(chatRes.status).toBe(409);

    const body = await chatRes.json();
    expect(body.attachments).toEqual([
      {
        name: "spec.md",
        mimeType: "text/markdown",
        size: 10,
        path: "storage/chat/s1/spec.md",
      },
    ]);
  });

  it("persists the runtime session link on abort so the next turn can resume", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      input.execution?.onEvent?.({
        type: "system:init",
        timestamp: new Date().toISOString(),
        data: { sessionId: "runtime-session-preserved" },
      });
      await new Promise<void>((_resolve, reject) => {
        input.execution?.abortController?.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
      return { outputText: "", sessionId: "runtime-session-preserved" };
    });

    mockUpdateChatSession.mockClear();

    const conversationId = crypto.randomUUID();
    const chatPromise = app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "first turn",
        clientId: "client-1",
        conversationId,
      }),
    });

    await new Promise((r) => setTimeout(r, 20));
    await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
    const chatRes = await chatPromise;
    expect(chatRes.status).toBe(409);

    expect(
      mockUpdateChatSession.mock.calls.some(
        (call) =>
          (call[1] as { runtimeSessionId?: string } | null)?.runtimeSessionId ===
          "runtime-session-preserved",
      ),
    ).toBe(true);
  });

  it("renders tool:question events as a markdown prompt with header, question, and numbered options", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-1",
          toolName: "AskUserQuestion",
          questions: [
            {
              question: "Which planner mode?",
              header: "Planning",
              options: [{ label: "Fast", description: "quick" }, { label: "Full" }],
            },
          ],
        },
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "/aif",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const combined = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    expect(combined).toContain("Planning");
    expect(combined).toContain("Which planner mode?");
    expect(combined).toContain("1. Fast");
    expect(combined).toContain("quick");
    expect(combined).toContain("2. Full");
    expect(combined).toContain("Answer by number");
  });

  it("suppresses noisy tool:use events and forwards non-noisy tools as a system line", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({ type: "tool:use", data: { name: "Read", input: {} } });
      onEvent?.({ type: "tool:use", data: { name: "Bash", input: { command: "ls" } } });
      onEvent?.({
        type: "tool:use",
        data: {
          name: "AskUserQuestion",
          input: { question: "ignored via tool:use" },
          interactive: true,
        },
      });
      // Future-proofing: any interactive tool (regardless of provider-specific
      // name) must be suppressed via the `interactive` flag, not a name match.
      onEvent?.({
        type: "tool:use",
        data: { name: "SomeOtherAdapterQuestion", input: {}, interactive: true },
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "noop",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const combined = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    expect(combined).not.toContain("🔧 Read");
    expect(combined).toContain("🔧 Bash");
    // Interactive tools must NOT be surfaced via tool:use — they render via tool:question.
    expect(combined).not.toContain("ignored via tool:use");
    expect(combined).not.toContain("🔧 AskUserQuestion");
    expect(combined).not.toContain("🔧 SomeOtherAdapterQuestion");
  });

  it("deduplicates repeated tool:question events with the same toolUseId", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      const payload = {
        toolUseId: "t-42",
        toolName: "AskUserQuestion",
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
      };
      onEvent?.({ type: "tool:question", data: payload });
      onEvent?.({ type: "tool:question", data: payload });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "go",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const questionOccurrences = tokenCalls.filter((call) =>
      String(call[1].payload.token).includes("Proceed?"),
    );
    expect(questionOccurrences.length).toBe(1);
  });

  it("deduplicates non-consecutive tool:question re-emits with the same toolUseId", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "t-repeat",
          toolName: "AskUserQuestion",
          questions: [{ question: "First question?", options: [{ label: "One" }] }],
        },
      });
      onEvent?.({ type: "stream:text", message: "Interleaving text." });
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "t-other",
          toolName: "AskUserQuestion",
          questions: [{ question: "Second question?", options: [{ label: "Two" }] }],
        },
      });
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "t-repeat",
          toolName: "AskUserQuestion",
          questions: [{ question: "First question?", options: [{ label: "One" }] }],
        },
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "go",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const questions = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    const firstCount = questions.split("First question?").length - 1;
    const secondCount = questions.split("Second question?").length - 1;
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });

  it("persists rendered AskUserQuestion block as an assistant message so it survives reload", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-persist",
          toolName: "AskUserQuestion",
          questions: [
            {
              question: "Which branch to use?",
              options: [{ label: "main" }, { label: "develop" }],
            },
          ],
        },
      });
      // Question-only turn — no assistant text from the runtime.
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "pick a branch",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantMessage).toContain("Which branch to use?");
    expect(body.assistantMessage).toContain("1. main");
    const persistCalls = mockCreateChatMessage.mock.calls.filter(
      (call) => (call[0] as { role: string }).role === "assistant",
    );
    expect(persistCalls.length).toBe(1);
    expect((persistCalls[0][0] as { content: string }).content).toContain("Which branch to use?");
    expect((persistCalls[0][0] as { content: string }).content).toContain("1. main");
  });

  it("renders a multi-select hint when the question has multiSelect=true", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-multi",
          toolName: "AskUserQuestion",
          questions: [
            {
              question: "Pick environments",
              multiSelect: true,
              options: [{ label: "dev" }, { label: "staging" }, { label: "prod" }],
            },
          ],
        },
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "go",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const combined = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    expect(combined).toContain("select multiple");
    expect(combined).not.toContain("Answer by number or free text in the next message.");
    expect(combined).toContain("Select one or more");
  });

  it("renders per-question selection hints and an ordered-answer hint when payload has multiple questions", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-many",
          toolName: "AskUserQuestion",
          questions: [
            {
              question: "Planner mode?",
              options: [{ label: "Fast" }, { label: "Full" }],
            },
            {
              question: "Target environments?",
              multiSelect: true,
              options: [{ label: "dev" }, { label: "prod" }],
            },
          ],
        },
      });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "go",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const combined = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    expect(combined).toContain("Planner mode?");
    expect(combined).toContain("Target environments?");
    expect(combined).toContain("Select one.");
    expect(combined).toContain("Select one or more");
    expect(combined).toContain("Answer each question in order");
    expect(combined).toContain("---");
  });

  it("renders tool:question without toolUseId (chat-layer dedupe by id cannot fire)", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      const payload = {
        toolUseId: null,
        toolName: "AskUserQuestion",
        questions: [{ question: "No id question?", options: [{ label: "Ok" }] }],
      };
      onEvent?.({ type: "tool:question", data: payload });
      onEvent?.({ type: "tool:question", data: payload });
      return { outputText: "", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "go",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const combined = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    // No toolUseId → both emissions render. Ensure at least one rendering happened.
    expect(combined).toContain("No id question?");
    const occurrences = tokenCalls.filter((call) =>
      String(call[1].payload.token).includes("No id question?"),
    );
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
  });

  it("includes AskUserQuestion hint in systemPromptAppend only for runtimes that support interactive questions", async () => {
    // Default fixture: Claude-like adapter with supportsInteractiveQuestions not set → absent.
    const adapterWithoutFlag: RuntimeAdapter = {
      ...runtimeAdapter,
      descriptor: {
        ...runtimeAdapter.descriptor,
        capabilities: {
          ...runtimeAdapter.descriptor.capabilities,
          supportsInteractiveQuestions: false,
        },
      },
    };
    mockResolveApiRuntimeContext.mockResolvedValueOnce({
      project: { id: "project-1", rootPath: "/tmp/project-1" },
      adapter: adapterWithoutFlag,
      resolvedProfile: {
        source: "project_default",
        profileId: "profile-1",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyEnvVar: null,
        headers: {},
        options: {},
      },
      selectionSource: "project_default",
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain",
      }),
    });
    expect(res.status).toBe(200);
    const runInput = mockAdapterRun.mock.calls[0]?.[0] as RuntimeRunInput;
    expect(runInput.execution?.systemPromptAppend).not.toContain("AskUserQuestion");

    // Claude-like adapter (flag=true) → hint must appear.
    mockAdapterRun.mockClear();
    const adapterWithFlag: RuntimeAdapter = {
      ...runtimeAdapter,
      descriptor: {
        ...runtimeAdapter.descriptor,
        capabilities: {
          ...runtimeAdapter.descriptor.capabilities,
          supportsInteractiveQuestions: true,
        },
      },
    };
    mockResolveApiRuntimeContext.mockResolvedValueOnce({
      project: { id: "project-1", rootPath: "/tmp/project-1" },
      adapter: adapterWithFlag,
      resolvedProfile: {
        source: "project_default",
        profileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyEnvVar: null,
        headers: {},
        options: {},
      },
      selectionSource: "project_default",
    });

    const res2 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "plain",
      }),
    });
    expect(res2.status).toBe(200);
    const runInput2 = mockAdapterRun.mock.calls[0]?.[0] as RuntimeRunInput;
    expect(runInput2.execution?.systemPromptAppend).toContain("AskUserQuestion");
  });

  it("prepends assistant outputText when a mixed text+AskUserQuestion turn streamed only the question (Claude CLI path)", async () => {
    // Simulates Claude CLI in partial-messages mode: text assistant-block is
    // accumulated into result.outputText but not re-emitted as stream:text,
    // while the tool_use block fires tool:question. UI + DB must still see
    // the intro text before the question block.
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-mixed",
          toolName: "AskUserQuestion",
          questions: [{ question: "Pick a mode", options: [{ label: "A" }, { label: "B" }] }],
        },
      });
      return { outputText: "Let me check the options.", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "mixed",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantMessage).toContain("Let me check the options.");
    expect(body.assistantMessage).toContain("Pick a mode");
    // Intro text must appear before the question block in the HTTP response.
    expect(body.assistantMessage.indexOf("Let me check the options.")).toBeLessThan(
      body.assistantMessage.indexOf("Pick a mode"),
    );
    // DB persist splits the assistant turn into two rows — intro text first,
    // rendered question block second — so it mirrors Claude replay's split
    // and mergeRuntimeAndDbMessages can dedupe on reload.
    const persistedAssistantCalls = mockCreateChatMessage.mock.calls.filter(
      (call) => (call[0] as { role: string }).role === "assistant",
    );
    expect(persistedAssistantCalls.length).toBe(2);
    expect((persistedAssistantCalls[0][0] as { content: string }).content).toBe(
      "Let me check the options.",
    );
    expect((persistedAssistantCalls[1][0] as { content: string }).content).toContain("Pick a mode");
    expect((persistedAssistantCalls[1][0] as { content: string }).content).not.toContain(
      "Let me check the options.",
    );
  });

  it("flushes tool:question tokens AFTER intro text so live chat:token order matches persisted order", async () => {
    // Regression for PR#77 review item #1 — the rendered question block must
    // not race ahead of the intro text on the live websocket. Intro may arrive
    // via `result.outputText` (Claude CLI mixed turn) or as `stream:text`
    // deltas, but either way the question must come last in the token stream.
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-order",
          toolName: "AskUserQuestion",
          questions: [{ question: "Pick a mode", options: [{ label: "A" }, { label: "B" }] }],
        },
      });
      return { outputText: "Let me check the options.", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "order",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const tokens = tokenCalls.map((call) => String(call[1].payload.token));
    const introIndex = tokens.findIndex((t) => t.includes("Let me check the options."));
    const questionIndex = tokens.findIndex((t) => t.includes("Pick a mode"));
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(introIndex).toBeLessThan(questionIndex);
  });

  it("does NOT duplicate assistant text when stream:text deltas already fired alongside a question", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({ type: "stream:text", message: "Let me check the options." });
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-dup",
          toolName: "AskUserQuestion",
          questions: [{ question: "Pick?", options: [{ label: "A" }] }],
        },
      });
      return { outputText: "Let me check the options.", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "nodup",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const occurrences = body.assistantMessage.split("Let me check the options.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("recovers missing outputText suffix when only a partial stream:text prefix was emitted", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({ type: "stream:text", message: "Let me check" });
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-hidden-suffix",
          toolName: "AskUserQuestion",
          questions: [{ question: "Pick?", options: [{ label: "A" }] }],
        },
      });
      return { outputText: "Let me check the options.", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "recover",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantMessage).toContain("Let me check the options.");
    expect(body.assistantMessage.indexOf("Let me check the options.")).toBeLessThan(
      body.assistantMessage.indexOf("Pick?"),
    );

    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const tokens = tokenCalls.map((call) => String(call[1].payload.token));
    const introIdx = tokens.findIndex((token) => token.includes("Let me check"));
    const recoveredSuffixIdx = tokens.findIndex((token) => token.includes(" the options."));
    const questionIdx = tokens.findIndex((token) => token.includes("Pick?"));
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(recoveredSuffixIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(introIdx).toBeLessThan(recoveredSuffixIdx);
    expect(recoveredSuffixIdx).toBeLessThan(questionIdx);
  });

  it("preserves text->question->text event order in websocket tokens and persisted assistant rows", async () => {
    mockAdapterRun.mockImplementation(async (input: RuntimeRunInput) => {
      const onEvent = input.execution?.onEvent as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onEvent?.({ type: "stream:text", message: "Before question. " });
      onEvent?.({
        type: "tool:question",
        data: {
          toolUseId: "tool-order-mid",
          toolName: "AskUserQuestion",
          questions: [{ question: "Confirm?", options: [{ label: "Yes" }] }],
        },
      });
      onEvent?.({ type: "stream:text", message: "After question." });
      return { outputText: "Before question. After question.", sessionId: "runtime-session-1" };
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        message: "order",
        clientId: "client-1",
      }),
    });

    expect(res.status).toBe(200);
    const tokenCalls = mockSendToClient.mock.calls.filter((call) => call[1]?.type === "chat:token");
    const tokens = tokenCalls.map((call) => String(call[1].payload.token)).join("");
    const beforeIdx = tokens.indexOf("Before question.");
    const questionIdx = tokens.indexOf("Confirm?");
    const afterIdx = tokens.indexOf("After question.");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(questionIdx);
    expect(questionIdx).toBeLessThan(afterIdx);

    const persistedAssistantCalls = mockCreateChatMessage.mock.calls.filter(
      (call) => (call[0] as { role: string }).role === "assistant",
    );
    expect(persistedAssistantCalls.length).toBe(3);
    expect((persistedAssistantCalls[0][0] as { content: string }).content).toContain(
      "Before question.",
    );
    expect((persistedAssistantCalls[1][0] as { content: string }).content).toContain("Confirm?");
    expect((persistedAssistantCalls[2][0] as { content: string }).content).toContain(
      "After question.",
    );
  });

  it("projects tool:question events as assistant messages when reading virtual runtime session history", async () => {
    mockGetApiRuntimeRegistry.mockResolvedValue({
      resolveRuntime: vi.fn(() => ({
        ...runtimeAdapter,
        getSession: vi.fn(),
        listSessionEvents: vi.fn(async () => [
          {
            type: "tool:question",
            timestamp: "2026-04-15T00:00:00.000Z",
            data: {
              toolUseId: "tool-reload",
              toolName: "AskUserQuestion",
              questions: [
                { question: "Which branch?", options: [{ label: "main" }, { label: "dev" }] },
              ],
            },
          },
        ]),
      })),
    });

    const res = await app.request("/chat/sessions/runtime:claude:abc/messages", { method: "GET" });
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toContain("Which branch?");
    expect(messages[0].content).toContain("1. main");
  });
});
