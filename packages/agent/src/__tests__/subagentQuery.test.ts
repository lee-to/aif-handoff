import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const logActivityMock = vi.fn();
const incrementTaskTokenUsageMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const fakeDb = {
  update: () => ({
    set: () => ({
      where: () => ({
        run: () => undefined,
      }),
    }),
  }),
};

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => fakeDb,
  };
});

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  return {
    ...actual,
    incrementTaskTokenUsage: incrementTaskTokenUsageMock,
    updateTaskHeartbeat: () => undefined,
  };
});

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      PORT: 3001,
      POLL_INTERVAL_MS: 30000,
      AGENT_STAGE_STALE_TIMEOUT_MS: 20 * 60 * 1000,
      AGENT_STAGE_STALE_MAX_RETRY: 3,
      AGENT_STAGE_RUN_TIMEOUT_MS: 15 * 60 * 1000,
      AGENT_QUERY_START_TIMEOUT_MS: 45 * 1000,
      AGENT_QUERY_START_RETRY_DELAY_MS: 1000,
      DATABASE_URL: "./data/aif.sqlite",
      CORS_ORIGIN: "*",
      API_BASE_URL: "http://localhost:3001",
      AGENT_QUERY_AUDIT_ENABLED: true,
      LOG_LEVEL: "debug",
      AGENT_USE_SUBAGENTS: true,
    }),
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

vi.mock("../claudeDiagnostics.js", () => ({
  createClaudeStderrCollector: () => ({
    onStderr: () => undefined,
    getTail: () => "mock stderr",
  }),
  explainClaudeFailure: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  probeClaudeCliFailure: async () => "",
}));

const { executeSubagentQuery } = await import("../subagentQuery.js");

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

describe("executeSubagentQuery query_start_timeout retry", () => {
  const baseOptions = {
    taskId: "task-1",
    projectRoot: "/tmp/project",
    agentName: "implement-coordinator",
    prompt: "run",
    queryStartTimeoutMs: 10,
    queryStartRetryDelayMs: 0,
  };

  beforeEach(() => {
    queryMock.mockReset();
    logActivityMock.mockReset();
    incrementTaskTokenUsageMock.mockReset();
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

    await expect(executeSubagentQuery(baseOptions)).rejects.toThrow(/query_start_timeout/i);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
