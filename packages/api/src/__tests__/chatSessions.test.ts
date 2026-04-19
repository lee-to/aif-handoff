import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { RuntimeAdapter } from "@aif/runtime";

const mockCreateChatSession = vi.fn();
const mockFindChatSessionById = vi.fn();
const mockListChatSessions = vi.fn();
const mockUpdateChatSession = vi.fn();
const mockDeleteChatSession = vi.fn();
const mockListChatMessages = vi.fn();
const mockToChatSessionResponse = vi.fn((row: Record<string, unknown>) => row);
const mockToChatMessageResponse = vi.fn((row: Record<string, unknown>) => row);
const mockFindProjectById = vi.fn();
const mockFindRuntimeProfileById = vi.fn();
const mockToRuntimeProfileResponse = vi.fn((row: Record<string, unknown>) => ({
  ...row,
  headers: row.headersJson ? JSON.parse(row.headersJson as string) : {},
  options: row.optionsJson ? JSON.parse(row.optionsJson as string) : {},
}));
const mockBroadcast = vi.fn();
const mockResolveApiRuntimeContext = vi.fn();
const mockGetApiRuntimeRegistry = vi.fn();
const mockSessionCacheKey = vi.fn((..._args: unknown[]) => "runtime-cache");

const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
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
  run: vi.fn(async () => ({ outputText: "", usage: null })),
  listSessions: (...args) => mockListSessions(...args),
  getSession: (...args) => mockGetSession(...args),
  listSessionEvents: (...args) => mockListSessionEvents(...args),
};

vi.mock("@aif/data", () => ({
  createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
  findChatSessionById: (...args: unknown[]) => mockFindChatSessionById(...args),
  listChatSessions: (...args: unknown[]) => mockListChatSessions(...args),
  updateChatSession: (...args: unknown[]) => mockUpdateChatSession(...args),
  deleteChatSession: (...args: unknown[]) => mockDeleteChatSession(...args),
  listChatMessages: (...args: unknown[]) => mockListChatMessages(...args),
  toChatSessionResponse: (row: Record<string, unknown>) => mockToChatSessionResponse(row),
  toChatMessageResponse: (row: Record<string, unknown>) => mockToChatMessageResponse(row),
  findProjectById: (id: string) => mockFindProjectById(id),
  findTaskById: vi.fn(),
  toTaskResponse: vi.fn(),
  createChatMessage: vi.fn(),
  updateChatSessionTimestamp: vi.fn(),
  findRuntimeProfileById: (id: string) => mockFindRuntimeProfileById(id),
  toRuntimeProfileResponse: (row: Record<string, unknown>) => mockToRuntimeProfileResponse(row),
  createDbUsageSink: () => ({ record: vi.fn() }),
}));

vi.mock("../services/runtime.js", () => ({
  resolveApiRuntimeContext: (input: unknown) => mockResolveApiRuntimeContext(input),
  assertApiRuntimeCapabilities: vi.fn(),
  getApiRuntimeRegistry: () => mockGetApiRuntimeRegistry(),
}));

vi.mock("../ws.js", () => ({
  sendToClient: vi.fn(),
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock("../services/sessionCache.js", () => ({
  getCached: vi.fn(() => undefined),
  setCached: vi.fn(),
  invalidateCache: vi.fn(),
  invalidateAllSessionCaches: vi.fn(),
  sessionCacheKey: (...args: unknown[]) => mockSessionCacheKey(...args),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      AGENT_BYPASS_PERMISSIONS: false,
      AIF_DEFAULT_RUNTIME_ID: "claude",
      AIF_DEFAULT_PROVIDER_ID: "anthropic",
    }),
  };
});

const { chatRouter } = await import("../routes/chat.js");

function createApp() {
  const app = new Hono();
  app.route("/chat", chatRouter);
  return app;
}

const SESSION_ROW = {
  id: "session-1",
  projectId: "proj-1",
  title: "Test Chat",
  agentSessionId: null,
  runtimeProfileId: null,
  runtimeSessionId: null,
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
};

describe("chat session API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();

    mockFindProjectById.mockReturnValue({ id: "proj-1", rootPath: "/tmp/proj", name: "Test" });
    mockListChatSessions.mockReturnValue([SESSION_ROW]);
    mockResolveApiRuntimeContext.mockResolvedValue({
      project: { id: "proj-1", rootPath: "/tmp/proj" },
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
    mockGetApiRuntimeRegistry.mockResolvedValue({
      resolveRuntime: vi.fn(() => runtimeAdapter),
    });
    mockListSessions.mockResolvedValue([]);
    mockGetSession.mockResolvedValue(null);
    mockListSessionEvents.mockResolvedValue([]);
    mockFindRuntimeProfileById.mockReturnValue(null);
  });

  describe("GET /chat/sessions", () => {
    it("returns 400 when projectId is missing", async () => {
      const res = await app.request("/chat/sessions");
      expect(res.status).toBe(400);
    });

    it("returns 404 when project is not found", async () => {
      mockFindProjectById.mockReturnValueOnce(undefined);
      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(404);
    });

    it("merges runtime sessions with DB sessions", async () => {
      mockListSessions.mockResolvedValue([
        {
          id: "runtime-abc",
          title: "Runtime Session",
          createdAt: "2026-04-01T12:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
        },
      ]);

      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBeGreaterThanOrEqual(2);
      expect(body.some((row: { id: string }) => row.id.startsWith("sdk:"))).toBe(true);
    });

    it("filters out already linked runtime sessions", async () => {
      mockListChatSessions.mockReturnValue([
        { ...SESSION_ROW, runtimeSessionId: "runtime-linked" },
      ]);
      mockListSessions.mockResolvedValue([
        {
          id: "runtime-linked",
          title: "Linked",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        },
      ]);

      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filter((row: { id: string }) => row.id.startsWith("sdk:")).length).toBe(0);
    });

    it("returns DB sessions when runtime discovery fails", async () => {
      mockListSessions.mockRejectedValue(new Error("runtime down"));
      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
    });
  });

  describe("POST /chat/sessions", () => {
    it("creates session and returns 201", async () => {
      mockCreateChatSession.mockReturnValue(SESSION_ROW);

      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1", title: "New Chat" }),
      });

      expect(res.status).toBe(201);
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chat:session_created" }),
      );
    });
  });

  describe("GET /chat/sessions/:id", () => {
    it("returns DB session when found", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);

      const res = await app.request("/chat/sessions/session-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("session-1");
    });

    it("returns virtual runtime session for sdk: id", async () => {
      mockGetSession.mockResolvedValue({
        id: "abc-123",
        title: "Runtime Session",
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T12:00:00Z",
      });

      const res = await app.request("/chat/sessions/sdk:abc-123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("sdk:abc-123");
      expect(body.title).toBe("Runtime Session");
    });

    it("passes runtime profile context to virtual session lookup", async () => {
      mockFindRuntimeProfileById.mockReturnValue({
        id: "profile-claude",
        projectId: null,
        name: "Claude Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        baseUrl: "https://api.example.test",
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "claude-sonnet",
        headersJson: JSON.stringify({ "x-profile": "1" }),
        optionsJson: JSON.stringify({ region: "us" }),
        enabled: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mockGetSession.mockResolvedValue({
        id: "abc-123",
        title: "Runtime Session",
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T12:00:00Z",
      });

      const res = await app.request(
        "/chat/sessions/sdk:abc-123?projectId=proj-1&runtimeProfileId=profile-claude",
      );

      expect(res.status).toBe(200);
      expect(mockGetSession).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: "claude",
          providerId: "anthropic",
          profileId: "profile-claude",
          sessionId: "abc-123",
          options: expect.objectContaining({
            region: "us",
            baseUrl: "https://api.example.test",
            apiKeyEnvVar: "OPENAI_API_KEY",
          }),
          headers: { "x-profile": "1" },
        }),
      );
      const body = await res.json();
      expect(body.runtimeProfileId).toBe("profile-claude");
    });
  });

  describe("GET /chat/sessions/:id/messages", () => {
    it("returns DB messages for DB sessions", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);
      mockListChatMessages.mockReturnValue([
        {
          id: "m1",
          sessionId: "session-1",
          role: "user",
          content: "Hello",
          createdAt: "2026-04-01T00:00:00Z",
        },
      ]);

      const res = await app.request("/chat/sessions/session-1/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].content).toBe("Hello");
    });

    it("returns mapped runtime messages for sdk: sessions", async () => {
      mockListSessionEvents.mockResolvedValue([
        {
          type: "message",
          timestamp: "2026-04-01T00:00:00Z",
          message: "Hello Claude",
          data: { role: "user", id: "m1" },
        },
        {
          type: "message",
          timestamp: "2026-04-01T00:00:01Z",
          message: "Hi there!",
          data: { role: "assistant", id: "m2" },
        },
      ]);

      const res = await app.request("/chat/sessions/sdk:abc-123/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].role).toBe("user");
      expect(body[1].role).toBe("assistant");
    });

    it("passes runtime profile context to virtual session event listing", async () => {
      mockFindRuntimeProfileById.mockReturnValue({
        id: "profile-claude",
        projectId: null,
        name: "Claude Profile",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        baseUrl: "https://api.example.test",
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "claude-sonnet",
        headersJson: JSON.stringify({ "x-profile": "1" }),
        optionsJson: JSON.stringify({ region: "us" }),
        enabled: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mockListSessionEvents.mockResolvedValue([]);

      const res = await app.request(
        "/chat/sessions/sdk:abc-123/messages?projectId=proj-1&runtimeProfileId=profile-claude",
      );
      expect(res.status).toBe(200);
      expect(mockListSessionEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: "claude",
          providerId: "anthropic",
          profileId: "profile-claude",
          sessionId: "abc-123",
          options: expect.objectContaining({
            region: "us",
            baseUrl: "https://api.example.test",
            apiKeyEnvVar: "OPENAI_API_KEY",
          }),
          headers: { "x-profile": "1" },
        }),
      );
    });

    it("deduplicates a mixed text+question turn on reload of a linked DB session", async () => {
      // Regression for PR#77 review item #2 — Claude replay splits a mixed
      // assistant turn into a `session-message` (intro text) and a separate
      // `tool:question`. POST now persists the same split shape (two rows),
      // so mergeRuntimeAndDbMessages matches each runtime event to its DB row
      // by exact trimmed-content equality instead of appending a stale
      // combined row as a third duplicate.
      mockFindChatSessionById.mockReturnValue({
        ...SESSION_ROW,
        runtimeSessionId: "runtime-linked",
      });

      const introContent = "Let me check the options.";
      const questionContent = [
        "",
        "",
        "**❓ Pick a mode**",
        "",
        "1. A",
        "2. B",
        "",
        "_Answer by number or free text in the next message._",
        "",
        "",
      ].join("\n");

      mockListChatMessages.mockReturnValue([
        {
          id: "m-user",
          sessionId: "session-1",
          role: "user",
          content: "mixed prompt",
          createdAt: "2026-04-10T00:00:00Z",
        },
        {
          id: "m-intro",
          sessionId: "session-1",
          role: "assistant",
          content: introContent,
          createdAt: "2026-04-10T00:00:01Z",
        },
        {
          id: "m-question",
          sessionId: "session-1",
          role: "assistant",
          content: questionContent.trim(),
          createdAt: "2026-04-10T00:00:02Z",
        },
      ]);

      mockListSessionEvents.mockResolvedValue([
        {
          type: "session-message",
          timestamp: "2026-04-10T00:00:00Z",
          message: "mixed prompt",
          data: { role: "user", id: "u1" },
        },
        {
          type: "session-message",
          timestamp: "2026-04-10T00:00:01Z",
          message: introContent,
          data: { role: "assistant", id: "a1" },
        },
        {
          type: "tool:question",
          timestamp: "2026-04-10T00:00:02Z",
          data: {
            toolUseId: "tool-reload",
            toolName: "AskUserQuestion",
            questions: [{ question: "Pick a mode", options: [{ label: "A" }, { label: "B" }] }],
          },
        },
      ]);

      const res = await app.request("/chat/sessions/session-1/messages");
      expect(res.status).toBe(200);
      const messages = (await res.json()) as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(3);
      expect(messages.filter((m) => m.role === "user").length).toBe(1);
      expect(messages.filter((m) => m.role === "assistant").length).toBe(2);
      expect(messages.filter((m) => m.content.includes("Let me check the options.")).length).toBe(
        1,
      );
      expect(messages.filter((m) => m.content.includes("Pick a mode")).length).toBe(1);
    });

    it("assigns a stable id to tool:question events based on toolUseId across repeated fetches", async () => {
      // Regression for PR#77 review item #3 — without this, eventId() falls
      // back to crypto.randomUUID() on every fetch, churning the UI's message
      // keys and causing visible list re-ordering/flicker on reload.
      mockListSessionEvents.mockResolvedValue([
        {
          type: "tool:question",
          timestamp: "2026-04-10T00:00:00Z",
          data: {
            toolUseId: "tool-stable-42",
            toolName: "AskUserQuestion",
            questions: [{ question: "Pick?", options: [{ label: "A" }] }],
          },
        },
      ]);

      const first = await app.request("/chat/sessions/sdk:stable-abc/messages");
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as Array<{ id: string; content: string }>;
      const second = await app.request("/chat/sessions/sdk:stable-abc/messages");
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as Array<{ id: string; content: string }>;

      expect(firstBody).toHaveLength(1);
      expect(secondBody).toHaveLength(1);
      expect(firstBody[0].id).toBe("tool:question:tool-stable-42");
      expect(secondBody[0].id).toBe(firstBody[0].id);
    });

    it("passes runtime profile options and headers when loading linked runtime session events", async () => {
      mockFindChatSessionById.mockReturnValue({
        ...SESSION_ROW,
        runtimeProfileId: "profile-oc",
        runtimeSessionId: "runtime-linked",
      });
      mockFindRuntimeProfileById.mockReturnValue({
        id: "profile-oc",
        projectId: null,
        name: "OpenCode",
        runtimeId: "opencode",
        providerId: "opencode",
        transport: "api",
        baseUrl: "http://127.0.0.1:60661",
        apiKeyEnvVar: null,
        defaultModel: null,
        headersJson: JSON.stringify({ "x-custom": "1" }),
        optionsJson: JSON.stringify({ serverPassword: "secret" }),
        enabled: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mockListSessionEvents.mockResolvedValue([]);

      const res = await app.request("/chat/sessions/session-1/messages");
      expect(res.status).toBe(200);
      expect(mockListSessionEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: "opencode",
          providerId: "opencode",
          profileId: "profile-oc",
          sessionId: "runtime-linked",
          options: expect.objectContaining({
            serverPassword: "secret",
            baseUrl: "http://127.0.0.1:60661",
          }),
          headers: { "x-custom": "1" },
        }),
      );
    });
  });

  describe("PUT /chat/sessions/:id", () => {
    it("updates title", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);
      mockUpdateChatSession.mockReturnValue({ ...SESSION_ROW, title: "Renamed" });

      const res = await app.request("/chat/sessions/session-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Renamed");
    });
  });

  describe("DELETE /chat/sessions/:id", () => {
    it("returns 204 and broadcasts deletion", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);

      const res = await app.request("/chat/sessions/session-1", { method: "DELETE" });
      expect(res.status).toBe(204);
      expect(mockDeleteChatSession).toHaveBeenCalledWith("session-1");
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chat:session_deleted" }),
      );
    });
  });
});
