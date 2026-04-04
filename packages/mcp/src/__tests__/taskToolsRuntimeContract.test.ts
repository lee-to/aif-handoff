import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects } from "@aif/shared";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

const broadcastTaskChangeMock = vi.fn(async () => undefined);
vi.mock("../utils/broadcast.js", () => ({
  broadcastTaskChange: broadcastTaskChangeMock,
}));

const { createRuntimeProfile, createTask } = await import("@aif/data");
const { register: registerCreateTask } = await import("../tools/createTask.js");
const { register: registerUpdateTask } = await import("../tools/updateTask.js");
const { register: registerGetTask } = await import("../tools/getTask.js");

function seedProject(id: string) {
  testDb.current
    .insert(projects)
    .values({ id, name: `Project ${id}`, rootPath: "/tmp/test" })
    .run();
}

interface RegisteredTool {
  schema: unknown;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

class MockMcpServer {
  tools = new Map<string, RegisteredTool>();

  tool(
    name: string,
    _description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  ) {
    this.tools.set(name, { schema, handler });
  }
}

const context = {
  rateLimiter: {
    check: () => true,
  },
};

describe("MCP task tools runtime contract", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject("proj-1");
    seedProject("proj-2");
    broadcastTaskChangeMock.mockClear();
  });

  it("rejects cross-project runtime profile on create", async () => {
    const foreignProfile = createRuntimeProfile({
      projectId: "proj-2",
      name: "Foreign Profile",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });

    const server = new MockMcpServer();
    registerCreateTask(server as any, context as any);
    const tool = server.tools.get("handoff_create_task");

    await expect(
      tool!.handler({
        projectId: "proj-1",
        title: "Cross Project Runtime",
        runtimeProfileId: foreignProfile!.id,
      }),
    ).rejects.toThrow(/does not belong to project/);
  });

  it("returns effectiveRuntime metadata on create", async () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Codex Runtime",
      runtimeId: "codex",
      providerId: "openai",
      enabled: true,
    });

    const server = new MockMcpServer();
    registerCreateTask(server as any, context as any);
    const tool = server.tools.get("handoff_create_task");

    const result = await tool!.handler({
      projectId: "proj-1",
      title: "Runtime Metadata Task",
      runtimeProfileId: profile!.id,
      modelOverride: "gpt-5.4",
      runtimeOptions: { approval: "never" },
    });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.runtimeProfileId).toBe(profile!.id);
    expect(payload.modelOverride).toBe("gpt-5.4");
    expect(payload.runtimeOptions).toEqual({ approval: "never" });
    expect(payload.effectiveRuntime).toEqual({
      source: "task_override",
      profileId: profile!.id,
      runtimeId: "codex",
      providerId: "openai",
      profileName: "Codex Runtime",
    });
  });

  it("rejects disabled runtime profile on update", async () => {
    const disabledProfile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Disabled Profile",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: false,
    });
    const task = createTask({
      projectId: "proj-1",
      title: "Update Runtime",
      description: "Test",
    });

    const server = new MockMcpServer();
    registerUpdateTask(server as any, context as any);
    const tool = server.tools.get("handoff_update_task");

    await expect(
      tool!.handler({
        taskId: task!.id,
        runtimeProfileId: disabledProfile!.id,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("returns runtime fields and effectiveRuntime via get task selection", async () => {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Claude Runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    const task = createTask({
      projectId: "proj-1",
      title: "Get Runtime Fields",
      description: "Test",
      runtimeProfileId: profile!.id,
      modelOverride: "sonnet",
      runtimeOptions: { effort: "high" },
    });

    const server = new MockMcpServer();
    registerGetTask(server as any, context as any);
    const tool = server.tools.get("handoff_get_task");

    const result = await tool!.handler({
      taskId: task!.id,
      fields: ["runtimeProfileId", "modelOverride", "runtimeOptions", "effectiveRuntime"],
    });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.id).toBe(task!.id);
    expect(payload.runtimeProfileId).toBe(profile!.id);
    expect(payload.modelOverride).toBe("sonnet");
    expect(payload.runtimeOptions).toEqual({ effort: "high" });
    expect(payload.effectiveRuntime).toEqual({
      source: "task_override",
      profileId: profile!.id,
      runtimeId: "claude",
      providerId: "anthropic",
      profileName: "Claude Runtime",
    });
  });
});
