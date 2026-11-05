import { afterAll, describe, expect, it, vi } from "vitest";
import { projects, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const db = createTestDb();
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db,
}));
vi.stubEnv("AIF_CHAT_THREAD_WORKSPACE_ENABLED", "false");
resetEnvCache();
const { createChatSession, toChatSessionResponse, updateChatSession } = await import("../index.js");
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("chat workspace disabled data compatibility", () => {
  it("keeps distinct legacy sessions and omits workspace status from their response", () => {
    db.insert(projects).values({ id: "project", name: "Project", rootPath: "/tmp/project" }).run();
    const first = createChatSession({ projectId: "project", runtimeSessionId: "runtime" })!;
    const second = createChatSession({ projectId: "project", runtimeSessionId: "runtime" })!;
    expect(second.id).not.toBe(first.id);
    expect(toChatSessionResponse(first)).not.toHaveProperty("status");
    expect(updateChatSession(first.id, { title: "Renamed", status: "done" })?.status).toBe("open");
  });
});
