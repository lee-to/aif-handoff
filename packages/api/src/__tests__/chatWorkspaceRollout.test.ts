import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { resetEnvCache } from "@aif/shared";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  workspace: vi.fn(),
  objective: vi.fn(),
  updateObjective: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  resolve: vi.fn(),
  broadcast: vi.fn(),
}));
const row = {
  id: "session-1",
  projectId: "project-1",
  title: "Chat",
  status: "open",
  runtimeProfileId: null,
  runtimeSessionId: null,
};
vi.mock("@aif/data", async (original) => ({
  ...(await original<typeof import("@aif/data")>()),
  createChatSession: mocks.create,
  updateChatSession: mocks.update,
  getThreadWorkspace: mocks.workspace,
  createThreadObjective: mocks.objective,
  updateThreadObjective: mocks.updateObjective,
  linkTaskToThread: mocks.link,
  unlinkTaskFromThread: mocks.unlink,
  findProjectById: () => ({ id: "project-1", name: "Project", rootPath: "/tmp/project" }),
  listChatMessages: () => [],
  findChatSessionById: () => row,
  toChatSessionResponse: (value: unknown) => value,
}));
vi.mock("../services/runtime.js", () => ({
  resolveApiRuntimeContext: mocks.resolve,
  assertApiRuntimeCapabilities: vi.fn(),
  getApiRuntimeRegistry: vi.fn(),
}));
vi.mock("../ws.js", () => ({ broadcast: mocks.broadcast, sendToClient: vi.fn() }));
vi.stubEnv("AIF_CHAT_THREAD_WORKSPACE_ENABLED", "false");
resetEnvCache();
const { chatRouter } = await import("../routes/chat.js");
const app = new Hono();
app.route("/chat", chatRouter);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue(row);
  mocks.update.mockReturnValue(row);
  mocks.resolve.mockRejectedValue(new Error("Discovery must stay disabled"));
});

describe("chat workspace rollout disabled", () => {
  it("blocks all workspace routes before validation or repository calls", async () => {
    for (const [method, path] of [
      ["GET", "/workspace"],
      ["POST", "/objectives"],
      ["PUT", "/objectives/objective"],
      ["PUT", "/tasks/task"],
      ["DELETE", "/tasks/task"],
    ]) {
      const response = await app.request(`/chat/sessions/session-1${path}`, { method });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "feature_disabled" });
    }
    for (const mock of [
      mocks.workspace,
      mocks.objective,
      mocks.updateObjective,
      mocks.link,
      mocks.unlink,
    ])
      expect(mock).not.toHaveBeenCalled();
  });
  it("keeps legacy message reads available", async () => {
    const response = await app.request("/chat/sessions/session-1/messages");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it("retains legacy session creation without runtime discovery", async () => {
    const response = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1", runtimeSessionId: "legacy-session" }),
    });
    expect(response.status).toBe(201);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("ignores the previously unknown status field on legacy metadata updates", async () => {
    const response = await app.request("/chat/sessions/session-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed", status: "not-a-thread-status" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ title: "Renamed", status: undefined }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
