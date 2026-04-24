import { describe, it, expect, beforeEach, vi } from "vitest";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  createChatSession,
  findChatSessionById,
  listChatSessions,
  updateChatSession,
  deleteChatSession,
  createChatMessage,
  listChatMessages,
  updateChatSessionTimestamp,
  toChatSessionResponse,
  toChatMessageResponse,
} = await import("../index.js");

function seedProject(id = "proj-1") {
  testDb.current
    .insert(projects)
    .values({ id, name: "Test", rootPath: "/tmp/test" })
    .run();
}

describe("chat sessions data layer", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
  });

  describe("createChatSession", () => {
    it("creates a session with default title", () => {
      const session = createChatSession({ projectId: "proj-1" });
      expect(session).toBeDefined();
      expect(session!.projectId).toBe("proj-1");
      expect(session!.title).toBe("New Chat");
      expect(session!.agentSessionId).toBeNull();
      expect(session!.runtimeProfileId).toBeNull();
      expect(session!.runtimeSessionId).toBeNull();
    });

    it("creates a session with custom title", () => {
      const session = createChatSession({ projectId: "proj-1", title: "My Chat" });
      expect(session).toBeDefined();
      expect(session!.title).toBe("My Chat");
    });

    it("persists runtime profile and session metadata from the create payload", () => {
      const session = createChatSession({
        projectId: "proj-1",
        runtimeProfileId: "runtime-profile-1",
        runtimeSessionId: "runtime-session-1",
      });

      expect(session).toBeDefined();
      expect(session!.runtimeProfileId).toBe("runtime-profile-1");
      expect(session!.runtimeSessionId).toBe("runtime-session-1");
    });
  });

  describe("findChatSessionById", () => {
    it("returns session when found", () => {
      const created = createChatSession({ projectId: "proj-1" });
      const found = findChatSessionById(created!.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created!.id);
    });

    it("returns undefined when not found", () => {
      expect(findChatSessionById("nonexistent")).toBeUndefined();
    });
  });

  describe("listChatSessions", () => {
    it("returns sessions for project ordered by updatedAt DESC", () => {
      const s1 = createChatSession({ projectId: "proj-1", title: "First" });
      const s2 = createChatSession({ projectId: "proj-1", title: "Second" });
      // Touch s1 to make it more recent
      updateChatSessionTimestamp(s1!.id);

      const sessions = listChatSessions("proj-1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe(s1!.id);
      expect(sessions[1].id).toBe(s2!.id);
    });

    it("does not return sessions for other projects", () => {
      seedProject("proj-2");
      createChatSession({ projectId: "proj-1" });
      createChatSession({ projectId: "proj-2" });

      const sessions = listChatSessions("proj-1");
      expect(sessions).toHaveLength(1);
    });
  });

  describe("updateChatSession", () => {
    it("updates title", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const updated = updateChatSession(session!.id, { title: "Renamed" });
      expect(updated!.title).toBe("Renamed");
    });

    it("updates agentSessionId", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const updated = updateChatSession(session!.id, { agentSessionId: "agent-123" });
      expect(updated!.agentSessionId).toBe("agent-123");
    });

    it("clears agentSessionId with null", () => {
      const session = createChatSession({ projectId: "proj-1" });
      updateChatSession(session!.id, { agentSessionId: "agent-123" });
      const updated = updateChatSession(session!.id, { agentSessionId: null });
      expect(updated!.agentSessionId).toBeNull();
    });
  });

  describe("deleteChatSession", () => {
    it("deletes session and its messages", () => {
      const session = createChatSession({ projectId: "proj-1" });
      createChatMessage({ sessionId: session!.id, role: "user", content: "Hello" });
      createChatMessage({ sessionId: session!.id, role: "assistant", content: "Hi" });

      deleteChatSession(session!.id);

      expect(findChatSessionById(session!.id)).toBeUndefined();
      expect(listChatMessages(session!.id)).toHaveLength(0);
    });
  });

  describe("createChatMessage", () => {
    it("creates a message linked to session", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const msg = createChatMessage({
        sessionId: session!.id,
        role: "user",
        content: "Hello there",
      });
      expect(msg).toBeDefined();
      expect(msg!.sessionId).toBe(session!.id);
      expect(msg!.role).toBe("user");
      expect(msg!.content).toBe("Hello there");
    });
  });

  describe("listChatMessages", () => {
    it("returns messages ordered by createdAt ASC", () => {
      const session = createChatSession({ projectId: "proj-1" });
      createChatMessage({ sessionId: session!.id, role: "user", content: "First" });
      createChatMessage({ sessionId: session!.id, role: "assistant", content: "Second" });
      createChatMessage({ sessionId: session!.id, role: "user", content: "Third" });

      const messages = listChatMessages(session!.id);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("First");
      expect(messages[1].content).toBe("Second");
      expect(messages[2].content).toBe("Third");
    });
  });

  describe("updateChatSessionTimestamp", () => {
    it("updates the updatedAt field to a recent time", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const before = Date.now();
      updateChatSessionTimestamp(session!.id);
      const updated = findChatSessionById(session!.id);
      expect(updated).toBeDefined();
      const ts = new Date(updated!.updatedAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before - 1000);
      expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe("toChatSessionResponse", () => {
    it("maps row to response format", () => {
      const session = createChatSession({ projectId: "proj-1", title: "Test" });
      const response = toChatSessionResponse(session!);
      expect(response).toEqual({
        id: session!.id,
        projectId: "proj-1",
        title: "Test",
        agentSessionId: null,
        runtimeProfileId: null,
        runtimeSessionId: null,
        source: "web",
        createdAt: session!.createdAt,
        updatedAt: session!.updatedAt,
      });
    });
  });

  describe("toChatMessageResponse", () => {
    it("maps row to response format", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const msg = createChatMessage({
        sessionId: session!.id,
        role: "user",
        content: "Hello",
      });
      const response = toChatMessageResponse(msg!);
      expect(response).toEqual({
        id: msg!.id,
        sessionId: session!.id,
        role: "user",
        content: "Hello",
        createdAt: msg!.createdAt,
      });
    });

    it("includes attachments when present", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const attachments = [
        { name: "file.txt", mimeType: "text/plain", size: 100, path: ".ai-factory/files/chat/s1/file.txt" },
        { name: "image.png", mimeType: "image/png", size: 5000, path: ".ai-factory/files/chat/s1/image.png" },
      ];
      const msg = createChatMessage({
        sessionId: session!.id,
        role: "user",
        content: "Check these",
        attachments,
      });
      const response = toChatMessageResponse(msg!);
      expect(response.content).toBe("Check these");
      expect(response.attachments).toEqual(attachments);
    });

    it("omits attachments when not stored", () => {
      const session = createChatSession({ projectId: "proj-1" });
      const msg = createChatMessage({
        sessionId: session!.id,
        role: "user",
        content: "No files",
      });
      const response = toChatMessageResponse(msg!);
      expect(response.attachments).toBeUndefined();
    });
  });
});
