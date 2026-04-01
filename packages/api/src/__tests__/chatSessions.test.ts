import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mockCreateChatSession = vi.fn();
const mockFindChatSessionById = vi.fn();
const mockListChatSessions = vi.fn();
const mockUpdateChatSession = vi.fn();
const mockDeleteChatSession = vi.fn();
const mockListChatMessages = vi.fn();
const mockCreateChatMessage = vi.fn();
const mockUpdateChatSessionTimestamp = vi.fn();
const mockToChatSessionResponse = vi.fn((row: Record<string, unknown>) => row);
const mockToChatMessageResponse = vi.fn((row: Record<string, unknown>) => row);
const mockFindProjectById = vi.fn();
const mockFindTaskById = vi.fn();
const mockToTaskResponse = vi.fn();
const mockQuery = vi.fn();
const mockSendToClient = vi.fn();
const mockBroadcast = vi.fn();
const mockListSessions = vi.fn();
const mockGetSessionMessages = vi.fn();
const mockGetSessionInfo = vi.fn();

vi.mock("@aif/data", () => ({
  createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
  findChatSessionById: (...args: unknown[]) => mockFindChatSessionById(...args),
  listChatSessions: (...args: unknown[]) => mockListChatSessions(...args),
  updateChatSession: (...args: unknown[]) => mockUpdateChatSession(...args),
  deleteChatSession: (...args: unknown[]) => mockDeleteChatSession(...args),
  createChatMessage: (...args: unknown[]) => mockCreateChatMessage(...args),
  listChatMessages: (...args: unknown[]) => mockListChatMessages(...args),
  updateChatSessionTimestamp: (...args: unknown[]) => mockUpdateChatSessionTimestamp(...args),
  toChatSessionResponse: (row: Record<string, unknown>) => mockToChatSessionResponse(row),
  toChatMessageResponse: (row: Record<string, unknown>) => mockToChatMessageResponse(row),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionMessages: (...args: unknown[]) => mockGetSessionMessages(...args),
  getSessionInfo: (...args: unknown[]) => mockGetSessionInfo(...args),
}));

vi.mock("../repositories/projects.js", () => ({
  findProjectById: (id: string) => mockFindProjectById(id),
}));

vi.mock("../repositories/tasks.js", () => ({
  findTaskById: (id: string) => mockFindTaskById(id),
  toTaskResponse: (row: unknown) => mockToTaskResponse(row),
}));

vi.mock("../ws.js", () => ({
  sendToClient: (...args: unknown[]) => mockSendToClient(...args),
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
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

const SESSION_ROW = {
  id: "session-1",
  projectId: "proj-1",
  title: "Test Chat",
  agentSessionId: null,
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
};

const MESSAGE_ROW = {
  id: "msg-1",
  sessionId: "session-1",
  role: "user",
  content: "Hello",
  createdAt: "2026-04-01T00:00:00Z",
};

describe("chat session API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
    mockToChatSessionResponse.mockImplementation((row) => row);
    mockToChatMessageResponse.mockImplementation((row) => row);
  });

  describe("GET /chat/sessions", () => {
    it("returns sessions list for project", async () => {
      mockListChatSessions.mockReturnValue([SESSION_ROW]);
      mockFindProjectById.mockReturnValue(undefined);

      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("session-1");
      expect(mockListChatSessions).toHaveBeenCalledWith("proj-1");
    });

    it("merges SDK sessions with DB sessions sorted by updatedAt", async () => {
      mockListChatSessions.mockReturnValue([SESSION_ROW]);
      mockFindProjectById.mockReturnValue({ id: "proj-1", rootPath: "/tmp/proj", name: "Test" });
      mockListSessions.mockResolvedValue([
        {
          sessionId: "sdk-abc",
          customTitle: "CLI session",
          summary: null,
          firstPrompt: null,
          createdAt: "2026-04-01T12:00:00Z",
          lastModified: "2026-04-02T00:00:00Z",
        },
      ]);

      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBeGreaterThanOrEqual(2);
      const sdkSession = body.find((s: { id: string }) => s.id === "sdk:sdk-abc");
      expect(sdkSession).toBeDefined();
      expect(sdkSession.title).toBe("CLI session");
      expect(sdkSession.source).toBe("cli");
    });

    it("excludes SDK sessions already linked to DB sessions", async () => {
      mockListChatSessions.mockReturnValue([{ ...SESSION_ROW, agentSessionId: "sdk-linked" }]);
      mockFindProjectById.mockReturnValue({ id: "proj-1", rootPath: "/tmp/proj", name: "Test" });
      mockListSessions.mockResolvedValue([
        { sessionId: "sdk-linked", customTitle: "Linked", lastModified: "2026-04-01T00:00:00Z" },
      ]);

      const res = await app.request("/chat/sessions?projectId=proj-1");
      const body = await res.json();
      const sdkIds = body.filter((s: { id: string }) => s.id.startsWith("sdk:"));
      expect(sdkIds).toHaveLength(0);
    });

    it("returns DB sessions only when SDK listing fails", async () => {
      mockListChatSessions.mockReturnValue([SESSION_ROW]);
      mockFindProjectById.mockReturnValue({ id: "proj-1", rootPath: "/tmp/proj", name: "Test" });
      mockListSessions.mockRejectedValue(new Error("SDK unavailable"));

      const res = await app.request("/chat/sessions?projectId=proj-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("session-1");
    });

    it("returns 400 when projectId is missing", async () => {
      const res = await app.request("/chat/sessions");
      expect(res.status).toBe(400);
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
      const body = await res.json();
      expect(body.id).toBe("session-1");
      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chat:session_created" }),
      );
    });

    it("returns 500 when session creation fails", async () => {
      mockCreateChatSession.mockReturnValue(null);

      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1", title: "Fail" }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /chat/sessions/:id", () => {
    it("returns session when found", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);

      const res = await app.request("/chat/sessions/session-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("session-1");
    });

    it("returns 404 when not found", async () => {
      mockFindChatSessionById.mockReturnValue(undefined);

      const res = await app.request("/chat/sessions/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns SDK session info for sdk: prefixed id", async () => {
      mockGetSessionInfo.mockResolvedValue({
        sessionId: "abc-123",
        customTitle: "My CLI Session",
        summary: null,
        firstPrompt: null,
        createdAt: "2026-04-01T00:00:00Z",
        lastModified: "2026-04-01T12:00:00Z",
      });

      const res = await app.request("/chat/sessions/sdk:abc-123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("sdk:abc-123");
      expect(body.title).toBe("My CLI Session");
      expect(body.source).toBe("cli");
    });

    it("falls back to summary/firstPrompt for SDK session title", async () => {
      mockGetSessionInfo.mockResolvedValue({
        sessionId: "abc-456",
        customTitle: null,
        summary: "A summary title",
        firstPrompt: "First prompt text",
        createdAt: null,
        lastModified: "2026-04-01T12:00:00Z",
      });

      const res = await app.request("/chat/sessions/sdk:abc-456");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("A summary title");
    });

    it("returns 404 when SDK session not found", async () => {
      mockGetSessionInfo.mockResolvedValue(null);

      const res = await app.request("/chat/sessions/sdk:nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 when SDK getSessionInfo throws", async () => {
      mockGetSessionInfo.mockRejectedValue(new Error("SDK error"));

      const res = await app.request("/chat/sessions/sdk:broken");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /chat/sessions/:id/messages", () => {
    it("returns messages list", async () => {
      mockFindChatSessionById.mockReturnValue(SESSION_ROW);
      mockListChatMessages.mockReturnValue([MESSAGE_ROW]);

      const res = await app.request("/chat/sessions/session-1/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].content).toBe("Hello");
    });

    it("returns 404 when session not found", async () => {
      mockFindChatSessionById.mockReturnValue(undefined);

      const res = await app.request("/chat/sessions/nonexistent/messages");
      expect(res.status).toBe(404);
    });

    it("returns SDK session messages for sdk: prefixed id", async () => {
      mockGetSessionMessages.mockResolvedValue([
        { uuid: "m1", type: "user", message: "Hello Claude" },
        {
          uuid: "m2",
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi there!" }] },
        },
        { uuid: "m3", type: "tool_result", message: "ignored" },
      ]);

      const res = await app.request("/chat/sessions/sdk:abc-123/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].role).toBe("user");
      expect(body[0].content).toBe("Hello Claude");
      expect(body[1].role).toBe("assistant");
      expect(body[1].content).toBe("Hi there!");
    });

    it("strips command tags from SDK messages", async () => {
      mockGetSessionMessages.mockResolvedValue([
        { uuid: "m1", type: "user", message: "<command-name>test</command-name>actual content" },
      ]);

      const res = await app.request("/chat/sessions/sdk:abc-123/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0].content).toBe("actual content");
    });

    it("filters out empty SDK messages", async () => {
      mockGetSessionMessages.mockResolvedValue([
        {
          uuid: "m1",
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "..." }] },
        },
      ]);

      const res = await app.request("/chat/sessions/sdk:abc-123/messages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(0);
    });

    it("returns 404 when SDK getSessionMessages throws", async () => {
      mockGetSessionMessages.mockRejectedValue(new Error("SDK error"));

      const res = await app.request("/chat/sessions/sdk:broken/messages");
      expect(res.status).toBe(404);
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

    it("returns 404 when session not found", async () => {
      mockFindChatSessionById.mockReturnValue(undefined);

      const res = await app.request("/chat/sessions/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X" }),
      });
      expect(res.status).toBe(404);
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

    it("returns 404 when session not found", async () => {
      mockFindChatSessionById.mockReturnValue(undefined);

      const res = await app.request("/chat/sessions/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
