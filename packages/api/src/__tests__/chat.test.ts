import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RuntimeExecutionError, type RuntimeAdapter, type RuntimeRunInput } from "@aif/runtime";

const mockFindProjectById = vi.fn();
const mockFindTaskById = vi.fn();
const mockToTaskResponse = vi.fn();
const mockCreateChatSession = vi.fn();
const mockFindChatSessionById = vi.fn();
const mockUpdateChatSession = vi.fn();
const mockCreateChatMessage = vi.fn();
const mockUpdateChatSessionTimestamp = vi.fn();
const mockSendToClient = vi.fn();
const mockBroadcast = vi.fn();
const mockInvalidateCache = vi.fn();
const mockResolveApiRuntimeContext = vi.fn();
const mockAssertApiRuntimeCapabilities = vi.fn();
const mockPersistAttachments = vi.fn();

const mockAdapterRun = vi.fn();
const mockAdapterResume = vi.fn();

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
    },
  },
  run: (input) => mockAdapterRun(input),
  resume: (input) => mockAdapterResume(input),
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
  listChatMessages: vi.fn(() => []),
  toChatSessionResponse: vi.fn((row: unknown) => row),
  toChatMessageResponse: vi.fn((row: unknown) => row),
  deleteChatSession: vi.fn(),
  findRuntimeProfileById: vi.fn(() => null),
}));

vi.mock("../services/runtime.js", () => ({
  resolveApiRuntimeContext: (input: unknown) => mockResolveApiRuntimeContext(input),
  assertApiRuntimeCapabilities: (input: unknown) => mockAssertApiRuntimeCapabilities(input),
  getApiRuntimeRegistry: vi.fn(),
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
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      AGENT_BYPASS_PERMISSIONS: false,
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
    mockPersistAttachments.mockResolvedValue([]);
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
    expect(mockSendToClient).toHaveBeenCalledWith(
      "client-1",
      expect.objectContaining({
        type: "chat:error",
        payload: expect.objectContaining({
          conversationId: "conv-limit-1",
          code: "CHAT_USAGE_LIMIT",
        }),
      }),
    );
  });

  it("returns 500 and generic code for non-limit failures", async () => {
    mockAdapterRun.mockRejectedValue(new Error("unexpected failure"));

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
    expect(await res.json()).toEqual({
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
});
