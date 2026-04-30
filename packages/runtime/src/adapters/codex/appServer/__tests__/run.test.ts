import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeTransport,
  UsageSource,
  type RuntimeEvent,
  type RuntimeRunInput,
} from "../../../../types.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

const activeChildren = new Set<ChildProcessWithoutNullStreams>();

const spawnCodexAppServerProcessMock = vi.fn();
const terminateCodexAppServerProcessMock = vi.fn();
const withProcessTimeoutsMock = vi.fn();

vi.mock("../process.js", () => ({
  spawnCodexAppServerProcess: (...args: unknown[]) => spawnCodexAppServerProcessMock(...args),
  terminateCodexAppServerProcess: (...args: unknown[]) =>
    terminateCodexAppServerProcessMock(...args),
}));

vi.mock("../../../../timeouts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../timeouts.js")>();
  return {
    ...actual,
    withProcessTimeouts: (...args: unknown[]) => withProcessTimeoutsMock(...args),
  };
});

const { runCodexAppServer } = await import("../run.js");

function spawnFixtureProcess(scenario: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    stdio: "pipe",
    env: {
      ...process.env,
      FAKE_CODEX_SCENARIO: scenario,
    },
  });
  activeChildren.add(child);
  return child;
}

async function terminateFixtureProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  activeChildren.delete(child);
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }
  child.kill();
  await once(child, "exit").catch(() => undefined);
}

function createRunInput(
  overrides: Partial<RuntimeRunInput> = {},
  scenario = "run-success",
): RuntimeRunInput {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "chat",
    transport: RuntimeTransport.APP_SERVER,
    prompt: "Hello from test",
    options: {
      testScenario: scenario,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    },
    usageContext: {
      source: UsageSource.CHAT,
      projectId: "project-1",
      chatSessionId: "chat-1",
    },
    execution: {
      startTimeoutMs: 500,
      runTimeoutMs: 5_000,
    },
    ...overrides,
  };
}

beforeEach(() => {
  spawnCodexAppServerProcessMock.mockReset();
  terminateCodexAppServerProcessMock.mockReset();
  withProcessTimeoutsMock.mockReset();
  withProcessTimeoutsMock.mockImplementation(() => ({
    cleanup: vi.fn(),
    startTimedOut: Promise.resolve(false),
    get runTimedOut() {
      return false;
    },
  }));

  spawnCodexAppServerProcessMock.mockImplementation(
    (input: {
      input: {
        options?: Record<string, unknown>;
        cwd?: string;
        projectRoot?: string;
      };
    }) => {
      const scenario =
        typeof input.input.options?.testScenario === "string"
          ? input.input.options.testScenario
          : "run-success";
      const child = spawnFixtureProcess(scenario);
      const stderrTail: string[] = [];
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrTail.push(String(chunk));
        while (stderrTail.length > 50) {
          stderrTail.shift();
        }
      });
      return {
        process: child,
        stderrTail,
        executablePath: process.execPath,
        args: [FIXTURE_PATH],
        cwd: input.input.cwd ?? input.input.projectRoot,
      };
    },
  );

  terminateCodexAppServerProcessMock.mockImplementation(
    async (context: { process: ChildProcessWithoutNullStreams }) => {
      await terminateFixtureProcess(context.process);
    },
  );
});

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => terminateFixtureProcess(child)));
});

describe("codex app-server run transport", () => {
  it("accumulates streamed output and usage from turn notifications", async () => {
    const observedEvents: string[] = [];
    const result = await runCodexAppServer(
      createRunInput({
        execution: {
          startTimeoutMs: 500,
          runTimeoutMs: 5_000,
          onEvent: (event) => {
            observedEvents.push(event.type);
          },
        },
      }),
    );

    expect(result.sessionId).toBe("thread-1");
    expect(result.outputText).toContain("Hello from fake app-server");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });
    expect(observedEvents).toContain("system:init");
    expect(observedEvents).toContain("stream:text");
    expect(observedEvents).toContain("result:success");
  });

  it("uses thread/resume for resumed turns and keeps the existing thread id", async () => {
    const result = await runCodexAppServer(
      createRunInput(
        {
          sessionId: "thread-resume-42",
          resume: true,
        },
        "resume-required",
      ),
    );

    expect(result.sessionId).toBe("thread-resume-42");
    expect(result.outputText).toContain("Hello from fake app-server");
  });

  it("forks the source thread before starting the turn for forked runs", async () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const result = await runCodexAppServer(
      createRunInput(
        {
          sourceSessionId: "thread-warm-source",
        } as Partial<RuntimeRunInput>,
        "fork-required",
      ),
      logger,
    );

    expect(result.sessionId).toBe("thread-warm-source-fork");
    expect(result.outputText).toContain("Hello from fake app-server");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadIdSuffix: "m-source",
      }),
      "DEBUG [runtime:codex] Starting Codex app-server thread fork",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadIdSuffix: "m-source",
        forkedThreadId: "thread-warm-source-fork",
      }),
      "INFO [runtime:codex] Codex app-server thread fork completed",
    );
  });

  it("sends turn/interrupt when AbortController is triggered", async () => {
    const abortController = new AbortController();
    const runPromise = runCodexAppServer(
      createRunInput(
        {
          execution: {
            startTimeoutMs: 500,
            runTimeoutMs: 5_000,
            abortController,
            onEvent: (event) => {
              if (event.type === "turn:started") {
                abortController.abort();
              }
            },
          },
        },
        "requires-interrupt",
      ),
    );

    const result = await runPromise;
    expect(result.outputText).toContain("Interrupted by client");
    expect(result.sessionId).toBe("thread-1");
  }, 15_000);

  it("sends deferred turn/interrupt when abort happens before turn id is known", async () => {
    const abortController = new AbortController();
    const runPromise = runCodexAppServer(
      createRunInput(
        {
          execution: {
            startTimeoutMs: 500,
            runTimeoutMs: 5_000,
            abortController,
          },
        },
        "delayed-turn-start-requires-interrupt",
      ),
    );
    setTimeout(() => abortController.abort(), 10);

    const result = await runPromise;
    expect(result.outputText).toContain("Interrupted by client");
    expect(result.sessionId).toBe("thread-1");
  }, 15_000);

  it("does not add an app-server hard run timeout when execution config omits it", async () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await runCodexAppServer(
      createRunInput(
        {
          execution: {
            startTimeoutMs: 500,
          },
        },
        "long-running-stage-success",
      ),
      logger,
    );

    expect(result.outputText).toContain("Long running fake app-server stage finished");
    expect(withProcessTimeoutsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        startTimeoutMs: 500,
        runTimeoutMs: undefined,
      }),
      logger,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runTimeoutMs: null,
      }),
      "INFO [runtime:codex] Starting Codex app-server run",
    );
  }, 15_000);

  it("honors an AbortController that was already aborted before listener registration", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await runCodexAppServer(
      createRunInput(
        {
          execution: {
            startTimeoutMs: 500,
            runTimeoutMs: 5_000,
            abortController,
          },
        },
        "requires-interrupt",
      ),
    );

    expect(result.outputText).toContain("Interrupted by client");
    expect(result.sessionId).toBe("thread-1");
  }, 15_000);

  it("fails active run immediately on malformed JSONL during notification streaming", async () => {
    await expect(
      runCodexAppServer(createRunInput({}, "malformed-after-turn-start")),
    ).rejects.toThrow("Malformed JSONL RPC payload from Codex app-server");
  });

  it("normalizes structured turn failures into runtime adapter errors", async () => {
    await expect(runCodexAppServer(createRunInput({}, "turn-failed"))).rejects.toMatchObject({
      message: "simulated turn failure",
      adapterCode: "CODEX_TRANSPORT_ERROR",
      category: "transport",
    });
  });

  it("surfaces MCP startup failures when the thread enters systemError", async () => {
    const observedEvents: RuntimeEvent[] = [];
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      runCodexAppServer(
        createRunInput(
          {
            execution: {
              startTimeoutMs: 500,
              runTimeoutMs: 5_000,
              onEvent: (event) => {
                observedEvents.push(event);
              },
            },
          },
          "mcp-startup-system-error",
        ),
        logger,
      ),
    ).rejects.toMatchObject({
      message: 'MCP server "filesystem" failed to start: configured root is not readable',
      adapterCode: "CODEX_TRANSPORT_ERROR",
      category: "transport",
    });

    expect(observedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "warning",
          message: 'MCP server "filesystem" failed to start: configured root is not readable',
        }),
        expect.objectContaining({
          type: "result:error",
          message: 'MCP server "filesystem" failed to start: configured root is not readable',
        }),
      ]),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "filesystem",
        status: "failed",
      }),
      "WARN [runtime:codex] Codex app-server MCP server startup failed",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "WARN [runtime:codex] Unknown non-fatal app-server notification received",
    );
  });

  it("reads thread state to enrich bare app-server system errors", async () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      runCodexAppServer(createRunInput({}, "system-error-thread-read"), logger),
    ).rejects.toMatchObject({
      message: "Provider rejected the request: invalid API key",
      adapterCode: "CODEX_AUTH_ERROR",
      category: "auth",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        codexErrorInfo: "unauthorized",
      }),
      "WARN [runtime:codex] Enriched Codex app-server failure from thread state",
    );
  });

  it("recursively reads thread state to enrich nested app-server system errors", async () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      runCodexAppServer(createRunInput({}, "system-error-thread-read-nested"), logger),
    ).rejects.toMatchObject({
      message: "Provider rejected nested request: nested invalid API key",
      adapterCode: "CODEX_AUTH_ERROR",
      category: "auth",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        codexErrorInfo: { unauthorized: {} },
      }),
      "WARN [runtime:codex] Enriched Codex app-server failure from thread state",
    );
  });

  it("logs thread read shape when app-server system errors have no persisted turn error", async () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      runCodexAppServer(createRunInput({}, "system-error-thread-read-empty"), logger),
    ).rejects.toMatchObject({
      adapterCode: "CODEX_TRANSPORT_ERROR",
      category: "transport",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        threadReadShape: expect.objectContaining({
          turnsCount: 0,
        }),
      }),
      "WARN [runtime:codex] Codex app-server thread read did not include a failed turn error",
    );
  });

  it.each([
    ["command", "approval-command-denied"],
    ["file-change", "approval-file-change-denied"],
    ["permissions", "approval-permissions-denied"],
  ])(
    "emits %s approval requests and fails when app-server approval is denied",
    async (_, scenario) => {
      const observedEvents: RuntimeEvent[] = [];

      await expect(
        runCodexAppServer(
          createRunInput(
            {
              execution: {
                startTimeoutMs: 500,
                runTimeoutMs: 5_000,
                onEvent: (event) => {
                  observedEvents.push(event);
                },
              },
            },
            scenario,
          ),
        ),
      ).rejects.toMatchObject({
        message: "Codex app-server approval request denied by AIF",
        adapterCode: "CODEX_PERMISSION_DENIED",
        category: "permission",
      });

      expect(observedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "approval:request" }),
          expect.objectContaining({
            type: "result:error",
            message: "Codex app-server approval request denied by AIF",
          }),
        ]),
      );
    },
  );
});
