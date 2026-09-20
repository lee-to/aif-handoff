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

const {
  createParticipant,
  createRuntimeProfile,
  createTask,
  getTaskOwnership,
  listAuditEvents,
  listTaskExecutorHistory,
  setTaskFields,
} = await import("@aif/data");
const { register: registerCreateTask } = await import("../tools/createTask.js");
const { register: registerUpdateTask } = await import("../tools/updateTask.js");
const { register: registerGetTask } = await import("../tools/getTask.js");
const { register: registerListTasks } = await import("../tools/listTasks.js");
const { register: registerSearchTasks } = await import("../tools/searchTasks.js");
const { register: registerSyncStatus } = await import("../tools/syncStatus.js");

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

  it("creates AI-owned tasks with an agent-attributed ownership record", async () => {
    const server = new MockMcpServer();
    registerCreateTask(server as any, context as any);
    const tool = server.tools.get("handoff_create_task");
    const result = await tool!.handler({
      projectId: "proj-1",
      title: "Agent-owned task",
    });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload).toMatchObject({
      executionOwner: "ai",
      ownershipRevision: 0,
      assignees: [],
    });
    expect(getTaskOwnership(payload.id)).toMatchObject({
      executionOwner: "ai",
      assignees: [],
    });
    expect(listTaskExecutorHistory(payload.id)[0]).toMatchObject({
      actor: {
        kind: "agent",
        id: "mcp",
        displayNameSnapshot: "MCP",
      },
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

  it("rejects ownership and participant fields in the generic update tool", async () => {
    const task = createTask({
      projectId: "proj-1",
      title: "Protected ownership",
      description: "Test",
    });
    const server = new MockMcpServer();
    registerUpdateTask(server as any, context as any);
    const tool = server.tools.get("handoff_update_task");

    await expect(
      tool!.handler({
        taskId: task!.id,
        executionOwner: "human",
        assigneeIds: ["participant-id"],
      }),
    ).rejects.toThrow(/ownership cannot be changed/i);
    expect(getTaskOwnership(task!.id)).toMatchObject({
      executionOwner: "ai",
      ownershipRevision: 0,
      assignees: [],
    });
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

  it("exposes owner and assignee fields through get/list/search filters", async () => {
    const participant = await createParticipant({
      username: "mcp-filter-member",
      displayName: "MCP Filter Member",
      password: "a sufficiently safe password",
    });
    expect(participant.ok).toBe(true);
    if (!participant.ok) return;
    const task = createTask({
      projectId: "proj-1",
      title: "Ownership searchable",
      description: "Filter contract",
      executionOwner: "human",
      assigneeIds: [participant.participant.id],
    });
    expect(task).toBeDefined();
    if (!task) return;

    const server = new MockMcpServer();
    registerGetTask(server as any, context as any);
    registerListTasks(server as any, context as any);
    registerSearchTasks(server as any, context as any);

    const getResult = await server.tools.get("handoff_get_task")!.handler({
      taskId: task.id,
      fields: ["executionOwner", "ownershipRevision", "assignees", "permissions"],
    });
    expect(JSON.parse(getResult.content[0]!.text)).toMatchObject({
      id: task.id,
      executionOwner: "human",
      assignees: [{ participantId: participant.participant.id }],
    });

    const listResult = await server.tools.get("handoff_list_tasks")!.handler({
      executionOwner: "human",
      assigneeId: participant.participant.id,
    });
    expect(JSON.parse(listResult.content[0]!.text)).toMatchObject({
      total: 1,
      items: [{ id: task.id, executionOwner: "human" }],
    });

    const searchResult = await server.tools.get("handoff_search_tasks")!.handler({
      query: "Ownership searchable",
      executionOwner: "human",
      assigneeId: participant.participant.id,
    });
    expect(JSON.parse(searchResult.content[0]!.text)).toMatchObject({
      total: 1,
      items: [{ id: task.id, executionOwner: "human" }],
    });
  });

  it("attributes MCP status transitions to the agent audit actor", async () => {
    const task = createTask({
      projectId: "proj-1",
      title: "Status audit",
      description: "",
      executionOwner: "ai",
    });
    expect(task).toBeDefined();
    if (!task) return;
    setTaskFields(task.id, { updatedAt: "2026-01-01T00:00:00.000Z" });

    const server = new MockMcpServer();
    registerSyncStatus(server as any, context as any);
    const result = await server.tools.get("handoff_sync_status")!.handler({
      taskId: task.id,
      newStatus: "planning",
      sourceTimestamp: "2026-07-24T00:00:00.000Z",
      direction: "aif_to_handoff",
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ applied: true });
    expect(
      listAuditEvents({ taskId: task.id }).find((event) => event.action === "task.status_synced"),
    ).toMatchObject({
      actor: {
        kind: "agent",
        id: "mcp",
        displayNameSnapshot: "MCP",
      },
      statusSnapshot: "planning",
    });
  });
});
