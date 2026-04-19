import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const logActivityMock = vi.fn();
const incrementTaskTokenUsageMock = vi.fn();
const persistRuntimeProfileLimitSnapshotMock = vi.fn();
const clearRuntimeProfileLimitSnapshotMock = vi.fn();
const notifyProjectRuntimeLimitBroadcastMock = vi.fn();
const saveTaskSessionIdMock = vi.fn();
const getTaskSessionIdMock = vi.fn(() => null);

interface MockTaskRow {
  id: string;
  projectId: string;
  runtimeOptionsJson: string | null;
  modelOverride: string | null;
}

interface MockEffectiveRuntimeProfile {
  source: string;
  profile: {
    id?: string;
    runtimeId: string;
    providerId: string;
    defaultModel?: string | null;
  } | null;
  taskRuntimeProfileId: string | null;
  projectRuntimeProfileId: string | null;
  systemRuntimeProfileId: string | null;
}

const findTaskByIdMock = vi.fn<(taskId: string) => MockTaskRow | undefined>(() => ({
  id: "task-1",
  projectId: "project-1",
  runtimeOptionsJson: null,
  modelOverride: null,
}));
const resolveEffectiveRuntimeProfileMock = vi.fn<
  (input: Record<string, unknown>) => MockEffectiveRuntimeProfile
>(() => ({
  source: "none",
  profile: null,
  taskRuntimeProfileId: null,
  projectRuntimeProfileId: null,
  systemRuntimeProfileId: null,
}));
(globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
  queryMock;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  listSessions: vi.fn(async () => []),
  getSessionInfo: vi.fn(async () => null),
  getSessionMessages: vi.fn(async () => []),
}));

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  return {
    ...actual,
    clearRuntimeProfileLimitSnapshot: clearRuntimeProfileLimitSnapshotMock,
    incrementTaskTokenUsage: incrementTaskTokenUsageMock,
    updateTaskHeartbeat: vi.fn(),
    renewTaskClaim: vi.fn(),
    persistRuntimeProfileLimitSnapshot: persistRuntimeProfileLimitSnapshotMock,
    saveTaskSessionId: saveTaskSessionIdMock,
    getTaskSessionId: getTaskSessionIdMock,
    findTaskById: findTaskByIdMock,
    resolveEffectiveRuntimeProfile: resolveEffectiveRuntimeProfileMock,
  };
});

const mockEnvOverrides: Record<string, unknown> = {};
const baseMockEnv = {
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_BASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  CODEX_CLI_PATH: undefined,
  AIF_RUNTIME_MODULES: [],
  AIF_DEFAULT_RUNTIME_ID: "claude",
  AIF_DEFAULT_PROVIDER_ID: "anthropic",
  PORT: 3009,
  POLL_INTERVAL_MS: 30000,
  AGENT_STAGE_STALE_TIMEOUT_MS: 90 * 60 * 1000,
  AGENT_STAGE_STALE_MAX_RETRY: 3,
  AGENT_STAGE_RUN_TIMEOUT_MS: 60 * 60 * 1000,
  AGENT_QUERY_START_TIMEOUT_MS: 60 * 1000,
  AGENT_QUERY_START_RETRY_DELAY_MS: 1000,
  DATABASE_URL: "./data/aif.sqlite",
  CORS_ORIGIN: "*",
  API_BASE_URL: "http://localhost:3009",
  AGENT_QUERY_AUDIT_ENABLED: true,
  LOG_LEVEL: "debug",
  ACTIVITY_LOG_MODE: "sync",
  ACTIVITY_LOG_BATCH_SIZE: 20,
  ACTIVITY_LOG_BATCH_MAX_AGE_MS: 5000,
  ACTIVITY_LOG_QUEUE_LIMIT: 500,
  AGENT_WAKE_ENABLED: true,
  AGENT_BYPASS_PERMISSIONS: true,
  COORDINATOR_MAX_CONCURRENT_TASKS: 3,
  AGENT_CHAT_MAX_TURNS: 50,
  AGENT_MAX_REVIEW_ITERATIONS: 3,
  AGENT_USE_SUBAGENTS: true,
  AGENT_FIRST_ACTIVITY_TIMEOUT_MS: 60_000,
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_USER_ID: undefined,
};

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({ ...baseMockEnv, ...mockEnvOverrides }),
    logger: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
  };
});

vi.mock("../hooks.js", () => ({
  createActivityLogger: () => async () => ({}),
  createSubagentLogger: () => async () => ({}),
  logActivity: logActivityMock,
  getClaudePath: () => "claude",
}));

vi.mock("../queryAudit.js", () => ({
  writeQueryAudit: () => undefined,
}));

vi.mock("../stderrCollector.js", () => ({
  createStderrCollector: () => ({
    onStderr: () => undefined,
    getTail: () => "mock stderr",
  }),
}));

vi.mock("../notifier.js", () => ({
  notifyProjectRuntimeLimitBroadcast: (...args: unknown[]) =>
    notifyProjectRuntimeLimitBroadcastMock(...args),
}));

const { executeSubagentQuery } = await import("../subagentQuery.js");
const { RuntimeExecutionError } = await import("@aif/runtime");

function makeDelayedSuccess(delayMs: number, result: string) {
  return async function* () {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield {
      type: "result",
      subtype: "success",
      result,
      usage: {},
      total_cost_usd: 0,
    };
  };
}

function makeSuccessWithSession(sessionId: string, result: string) {
  return async function* () {
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
    };
    yield {
      type: "result",
      subtype: "success",
      result,
      usage: {},
      total_cost_usd: 0,
    };
  };
}

describe("executeSubagentQuery attribution", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: null,
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes empty attribution to suppress Co-Authored-By trailers", async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await executeSubagentQuery({
      taskId: "task-attr",
      projectRoot: "/tmp/project",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    const callOptions = queryMock.mock.calls[0][0].options;
    expect(callOptions.settings).toEqual(
      expect.objectContaining({ attribution: { commit: "", pr: "" } }),
    );
  });
});

describe("executeSubagentQuery query_start_timeout retry", () => {
  const baseOptions = {
    taskId: "task-1",
    projectRoot: "/tmp/project",
    agentName: "implement-coordinator",
    prompt: "run",
    queryStartTimeoutMs: 10,
    queryStartRetryDelayMs: 0,
    workflowKind: "implementer",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: null,
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once after query_start_timeout and succeeds on second attempt", async () => {
    queryMock
      .mockImplementationOnce(makeDelayedSuccess(40, "late-result"))
      .mockImplementationOnce(makeDelayedSuccess(0, "ok-second-attempt"));

    const result = await executeSubagentQuery(baseOptions);

    expect(result.resultText).toBe("ok-second-attempt");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("throws when query_start_timeout happens on both attempts", async () => {
    queryMock
      .mockImplementationOnce(makeDelayedSuccess(40, "late-1"))
      .mockImplementationOnce(makeDelayedSuccess(40, "late-2"));

    await expect(executeSubagentQuery(baseOptions)).rejects.toThrow(/timed out/i);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe("executeSubagentQuery session persistence policy", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: null,
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists runtime session for resume_if_available workflows", async () => {
    queryMock.mockImplementation(makeSuccessWithSession("session-impl-1", "done"));

    await executeSubagentQuery({
      taskId: "task-resume",
      projectRoot: "/tmp/project",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    expect(saveTaskSessionIdMock).toHaveBeenCalledWith("task-resume", "session-impl-1");
  });

  it("does not persist runtime session for new_session workflows", async () => {
    queryMock.mockImplementation(makeSuccessWithSession("session-review-1", "done"));

    await executeSubagentQuery({
      taskId: "task-review",
      projectRoot: "/tmp/project",
      agentName: "review-sidecar",
      prompt: "run",
      workflowSpec: {
        workflowKind: "reviewer",
        promptInput: { prompt: "run" },
        requiredCapabilities: [],
        fallbackStrategy: "none",
        sessionReusePolicy: "new_session",
      },
    });

    expect(saveTaskSessionIdMock).not.toHaveBeenCalled();
  });
});

describe("executeSubagentQuery runtime limit state refresh", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "project_default",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: null,
      },
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: "profile-1",
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists runtime profile limit snapshots from Claude rate_limit_event", async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.96,
          resetsAt: 1_776_389_600,
        },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await executeSubagentQuery({
      taskId: "task-limit",
      projectRoot: "/tmp/project",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    expect(persistRuntimeProfileLimitSnapshotMock).toHaveBeenCalledTimes(1);
    expect(persistRuntimeProfileLimitSnapshotMock).toHaveBeenCalledWith(
      "profile-1",
      expect.objectContaining({
        status: "warning",
        source: "sdk_event",
        profileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
      }),
      expect.any(String),
    );
    expect(clearRuntimeProfileLimitSnapshotMock).not.toHaveBeenCalled();
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenCalledWith("project-1", "profile-1", {
      taskId: "task-limit",
    });
  });

  it("preserves runtime profile limit state after successful runs without limit metadata", async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await executeSubagentQuery({
      taskId: "task-clear-limit",
      projectRoot: "/tmp/project",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    expect(clearRuntimeProfileLimitSnapshotMock).not.toHaveBeenCalled();
    expect(persistRuntimeProfileLimitSnapshotMock).not.toHaveBeenCalled();
    expect(notifyProjectRuntimeLimitBroadcastMock).not.toHaveBeenCalled();
  });

  it("broadcasts project-scoped runtime updates for each project even when DB dedupe skips identical snapshot write", async () => {
    notifyProjectRuntimeLimitBroadcastMock.mockResolvedValue(true);

    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "project_default",
      profile: {
        id: "profile-shared-global",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: null,
      },
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: "profile-shared-global",
      systemRuntimeProfileId: null,
    });

    const tasksById: Record<string, MockTaskRow> = {
      "task-project-a": {
        id: "task-project-a",
        projectId: "project-A",
        runtimeOptionsJson: null,
        modelOverride: null,
      },
      "task-project-b": {
        id: "task-project-b",
        projectId: "project-B",
        runtimeOptionsJson: null,
        modelOverride: null,
      },
    };
    findTaskByIdMock.mockImplementation((taskId: string) => tasksById[taskId]);

    queryMock.mockImplementation(async function* () {
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.96,
          resetsAt: 1_776_389_600,
        },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await executeSubagentQuery({
      taskId: "task-project-a",
      projectRoot: "/tmp/project-a",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    await executeSubagentQuery({
      taskId: "task-project-b",
      projectRoot: "/tmp/project-b",
      agentName: "implement-coordinator",
      prompt: "run",
      workflowKind: "implementer",
    });

    expect(persistRuntimeProfileLimitSnapshotMock).toHaveBeenCalledTimes(1);
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenCalledTimes(2);
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenNthCalledWith(
      1,
      "project-A",
      "profile-shared-global",
      { taskId: "task-project-a" },
    );
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenNthCalledWith(
      2,
      "project-B",
      "profile-shared-global",
      { taskId: "task-project-b" },
    );
  });
});

describe("executeSubagentQuery error redaction", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: null,
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not write raw provider error body to agent activity log", async () => {
    queryMock.mockImplementation(async function* () {
      throw new RuntimeExecutionError(
        '429 {"error":"secret_token=abc sk-SECRET"}',
        undefined,
        "rate_limit",
      );
    });

    await expect(
      executeSubagentQuery({
        taskId: "task-redaction",
        projectRoot: "/tmp/project",
        agentName: "implement-coordinator",
        prompt: "run",
        workflowKind: "implementer",
      }),
    ).rejects.toThrow("Runtime usage limit reached.");

    const agentMessages = logActivityMock.mock.calls
      .filter((call: unknown[]) => call[1] === "Agent")
      .map((call: unknown[]) => String(call[2] ?? ""));
    const combined = agentMessages.join("\n");

    expect(combined).toContain("Runtime usage limit reached.");
    expect(combined).not.toContain("secret_token");
    expect(combined).not.toContain("sk-SECRET");
  });
});

describe("executeSubagentQuery model fallback policy", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
    persistRuntimeProfileLimitSnapshotMock.mockReset();
    clearRuntimeProfileLimitSnapshotMock.mockReset();
    saveTaskSessionIdMock.mockReset();
    getTaskSessionIdMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: "task-model",
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "task_default",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "profile-model",
      },
      taskRuntimeProfileId: "profile-1",
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses task modelOverride as highest priority", async () => {
    queryMock.mockImplementation(makeDelayedSuccess(0, "ok"));

    await executeSubagentQuery({
      taskId: "task-1",
      projectRoot: "/tmp/project",
      agentName: "review-gate",
      prompt: "check",
      workflowKind: "review-gate",
    });

    const callOptions = queryMock.mock.calls[0][0].options as Record<string, unknown>;
    expect(callOptions.model).toBe("task-model");
  });

  it("uses profile defaultModel when no task override", async () => {
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    queryMock.mockImplementation(makeDelayedSuccess(0, "ok"));

    await executeSubagentQuery({
      taskId: "task-1",
      projectRoot: "/tmp/project",
      agentName: "review-gate",
      prompt: "check",
      workflowKind: "review-gate",
    });

    const callOptions = queryMock.mock.calls[0][0].options as Record<string, unknown>;
    expect(callOptions.model).toBe("profile-model");
  });

  it("does not inject lightModel when no task override and no profile model", async () => {
    // lightModel should only be used when explicitly passed via modelOverride
    // (e.g. reviewGate.ts), not as a general fallback for all tasks
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: null,
      },
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
    queryMock.mockImplementation(makeDelayedSuccess(0, "ok"));

    await executeSubagentQuery({
      taskId: "task-1",
      projectRoot: "/tmp/project",
      agentName: "review-gate",
      prompt: "check",
      workflowKind: "review-gate",
    });

    const callOptions = queryMock.mock.calls[0][0].options as Record<string, unknown>;
    expect(callOptions.model).toBeUndefined();
  });

  it("omits model entirely when suppression is enabled", async () => {
    queryMock.mockImplementation(makeDelayedSuccess(0, "ok"));

    await executeSubagentQuery({
      taskId: "task-1",
      projectRoot: "/tmp/project",
      agentName: "review-gate",
      prompt: "check",
      workflowKind: "review-gate",
      modelOverride: null,
      suppressModelFallback: true,
    });

    const callOptions = queryMock.mock.calls[0][0].options as Record<string, unknown>;
    expect(callOptions).not.toHaveProperty("model");
  });
});

describe("executeSubagentQuery first-activity watchdog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    queryMock.mockReset();
    logActivityMock.mockReset();
    findTaskByIdMock.mockReset();
    resolveEffectiveRuntimeProfileMock.mockReset();
    getTaskSessionIdMock.mockReturnValue(null);
    findTaskByIdMock.mockReturnValue({
      id: "task-1",
      projectId: "project-1",
      runtimeOptionsJson: null,
      modelOverride: null,
    });
    resolveEffectiveRuntimeProfileMock.mockReturnValue({
      source: "none",
      profile: null,
      taskRuntimeProfileId: null,
      projectRuntimeProfileId: null,
      systemRuntimeProfileId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries and eventually throws when agent stalls on all attempts", async () => {
    // Use very short timeouts for the test
    mockEnvOverrides.AGENT_FIRST_ACTIVITY_TIMEOUT_MS = 100;
    mockEnvOverrides.AGENT_QUERY_START_TIMEOUT_MS = 0;

    // queryMock is called as queryImpl({ prompt, options }).
    // options.abortController is the per-attempt AbortController from executionIntent.
    // In production, SDKs use this signal to cancel HTTP requests; here we simulate
    // the same: yield once (pass start-timeout), then hang until abort fires.
    queryMock.mockImplementation(
      (input: { prompt: string; options: { abortController?: AbortController } }) => {
        const ac = input.options?.abortController;
        async function* hangUntilAbort() {
          yield { type: "message", message: { type: "text", text: "thinking..." } };
          await new Promise<void>((_, reject) => {
            if (ac?.signal.aborted) {
              reject(new Error("first_activity_timeout"));
              return;
            }
            ac?.signal.addEventListener(
              "abort",
              () => {
                reject(new Error("first_activity_timeout"));
              },
              { once: true },
            );
          });
        }
        return hangUntilAbort();
      },
    );

    await expect(
      executeSubagentQuery({
        taskId: "task-stall",
        projectRoot: "/tmp/project",
        agentName: "implement-coordinator",
        prompt: "run",
        workflowKind: "implementer",
      }),
    ).rejects.toThrow(/stalled|first_activity_timeout|timed out/i);

    // Should have been called 3 times (1 initial + 2 retries)
    expect(queryMock).toHaveBeenCalledTimes(3);

    // Verify stall was logged in activity
    const stallLogs = logActivityMock.mock.calls.filter(
      (call: string[]) => call[1] === "Agent" && call[2]?.includes("stalled"),
    );
    expect(stallLogs.length).toBe(3);

    delete mockEnvOverrides.AGENT_FIRST_ACTIVITY_TIMEOUT_MS;
    delete mockEnvOverrides.AGENT_QUERY_START_TIMEOUT_MS;
  }, 10_000);

  it("treats streamed runtime events as activity for tool-less workflows", async () => {
    mockEnvOverrides.AGENT_FIRST_ACTIVITY_TIMEOUT_MS = 100;
    mockEnvOverrides.AGENT_QUERY_START_TIMEOUT_MS = 0;

    queryMock.mockImplementation(async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "session-tool-less",
      };
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield {
        type: "result",
        subtype: "success",
        result: "done-without-tools",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await expect(
      executeSubagentQuery({
        taskId: "task-tool-less",
        projectRoot: "/tmp/project",
        agentName: "implement-checklist-sync",
        prompt: "run",
        workflowKind: "implementer_checklist_sync",
      }),
    ).resolves.toEqual({ resultText: "done-without-tools" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const stallLogs = logActivityMock.mock.calls.filter(
      (call: string[]) => call[1] === "Agent" && call[2]?.includes("stalled"),
    );
    expect(stallLogs.length).toBe(0);

    delete mockEnvOverrides.AGENT_FIRST_ACTIVITY_TIMEOUT_MS;
    delete mockEnvOverrides.AGENT_QUERY_START_TIMEOUT_MS;
  });
});
