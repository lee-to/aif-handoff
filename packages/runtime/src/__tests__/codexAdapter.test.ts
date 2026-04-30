import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

const runCodexCliMock = vi.fn();
const probeCodexCliMock = vi.fn();
const runCodexAgentApiMock = vi.fn();
const runCodexSdkMock = vi.fn();
const runCodexAppServerMock = vi.fn();
const validateCodexAgentApiConnectionMock = vi.fn();
const listCodexAgentApiModelsMock = vi.fn();
const listCodexAppServerModelsMock = vi.fn();
const spawnCodexAppServerProcessMock = vi.fn();
const terminateCodexAppServerProcessMock = vi.fn();
const jsonlRpcClientCtorMock = vi.fn();
const appServerInitializeMock = vi.fn();
const appServerCloseMock = vi.fn();

vi.mock("../adapters/codex/cli.js", () => ({
  runCodexCli: (...args: unknown[]) => runCodexCliMock(...args),
  probeCodexCli: (...args: unknown[]) => probeCodexCliMock(...args),
}));

vi.mock("../adapters/codex/api.js", () => ({
  runCodexAgentApi: (...args: unknown[]) => runCodexAgentApiMock(...args),
  validateCodexAgentApiConnection: (...args: unknown[]) =>
    validateCodexAgentApiConnectionMock(...args),
  listCodexAgentApiModels: (...args: unknown[]) => listCodexAgentApiModelsMock(...args),
}));

vi.mock("../adapters/codex/modelDiscovery.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/codex/modelDiscovery.js")>(
    "../adapters/codex/modelDiscovery.js",
  );
  return {
    ...actual,
    listCodexAppServerModels: (...args: unknown[]) => listCodexAppServerModelsMock(...args),
  };
});
vi.mock("../adapters/codex/sdk.js", () => ({
  runCodexSdk: (...args: unknown[]) => runCodexSdkMock(...args),
}));
vi.mock("../adapters/codex/appServer/run.js", () => ({
  runCodexAppServer: (...args: unknown[]) => runCodexAppServerMock(...args),
}));
vi.mock("../adapters/codex/appServer/process.js", () => ({
  spawnCodexAppServerProcess: (...args: unknown[]) => spawnCodexAppServerProcessMock(...args),
  terminateCodexAppServerProcess: (...args: unknown[]) =>
    terminateCodexAppServerProcessMock(...args),
}));
vi.mock("../adapters/codex/appServer/jsonlRpcClient.js", () => ({
  JsonlRpcResponseError: class JsonlRpcResponseErrorMock extends Error {},
  JsonlRpcClient: class JsonlRpcClientMock {
    constructor(...args: unknown[]) {
      jsonlRpcClientCtorMock(...args);
    }
  },
}));
vi.mock("../adapters/codex/appServer/client.js", () => ({
  CodexAppServerClient: class CodexAppServerClientMock {
    initialize(...args: unknown[]) {
      return appServerInitializeMock(...args);
    }

    close(...args: unknown[]) {
      return appServerCloseMock(...args);
    }
  },
}));

const { createCodexRuntimeAdapter } = await import("../adapters/codex/index.js");

function createRunInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    workflowKind: "implementer",
    prompt: "Implement feature",
    options: {},
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

describe("Codex runtime adapter", () => {
  beforeEach(() => {
    runCodexCliMock.mockReset();
    runCodexAgentApiMock.mockReset();
    runCodexSdkMock.mockReset();
    runCodexAppServerMock.mockReset();
    probeCodexCliMock.mockReset();
    validateCodexAgentApiConnectionMock.mockReset();
    spawnCodexAppServerProcessMock.mockReset();
    terminateCodexAppServerProcessMock.mockReset();
    jsonlRpcClientCtorMock.mockReset();
    appServerInitializeMock.mockReset();
    appServerCloseMock.mockReset();
    runCodexCliMock.mockResolvedValue({ outputText: "cli-output", sessionId: "cli-session" });
    runCodexAgentApiMock.mockResolvedValue({
      outputText: "agentapi-output",
      sessionId: "agentapi-session",
    });
    runCodexSdkMock.mockResolvedValue({ outputText: "sdk-output", sessionId: "sdk-session" });
    runCodexAppServerMock.mockResolvedValue({
      outputText: "app-server-output",
      sessionId: "thread-1",
      usage: null,
    });
    probeCodexCliMock.mockReturnValue({ ok: true, version: "1.0.0" });
    validateCodexAgentApiConnectionMock.mockResolvedValue({
      ok: true,
      message: "agentapi ok",
    });
    listCodexAgentApiModelsMock.mockReset();
    listCodexAgentApiModelsMock.mockResolvedValue([]);
    listCodexAppServerModelsMock.mockReset();
    listCodexAppServerModelsMock.mockResolvedValue([]);
    spawnCodexAppServerProcessMock.mockReturnValue({
      process: { pid: 1234 },
      stderrTail: [],
      executablePath: "codex",
      args: ["app-server"],
      cwd: undefined,
    });
    terminateCodexAppServerProcessMock.mockResolvedValue(undefined);
    appServerInitializeMock.mockResolvedValue({});
    appServerCloseMock.mockReturnValue(undefined);
  });

  it("exposes codex descriptor and capabilities", () => {
    const adapter = createCodexRuntimeAdapter();
    expect(adapter.descriptor.id).toBe("codex");
    expect(adapter.descriptor.providerId).toBe("openai");
    expect(adapter.descriptor.defaultTransport).toBe("cli");
    expect(adapter.descriptor.capabilities.supportsModelDiscovery).toBe(true);
    expect(adapter.descriptor.capabilities.supportsCustomEndpoint).toBe(true);
    expect(adapter.descriptor.capabilities.supportsAgentDefinitions).toBe(false);
    expect(adapter.descriptor.capabilities.supportsSessionFork).toBe(false);
    expect(adapter.descriptor.capabilities.supportsSessionList).toBe(false);
    expect(adapter.descriptor.skillCommandPrefix).toBe("$");
    expect(adapter.descriptor.supportsProjectInit).toBe(true);
    expect(adapter.descriptor.supportedTransports).toContain("app-server");
  });

  it("reports session fork support only for app-server transport", () => {
    const adapter = createCodexRuntimeAdapter();

    expect(adapter.getEffectiveCapabilities!("cli").supportsSessionFork).toBe(false);
    expect(adapter.getEffectiveCapabilities!("sdk").supportsSessionFork).toBe(false);
    expect(adapter.getEffectiveCapabilities!("api").supportsSessionFork).toBe(false);
    expect(adapter.getEffectiveCapabilities!("app-server").supportsSessionFork).toBe(true);
  });

  it("runs via CLI transport by default", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.run(createRunInput());
    expect(result.outputText).toBe("cli-output");
    expect(runCodexCliMock).toHaveBeenCalledTimes(1);
    expect(runCodexAgentApiMock).not.toHaveBeenCalled();
  });

  it("runs via API when transport is 'api' or legacy 'agentapi'", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.run(
      createRunInput({
        transport: "agentapi",
      }),
    );
    expect(result.outputText).toBe("agentapi-output");
    expect(runCodexAgentApiMock).toHaveBeenCalledTimes(1);
    expect(runCodexCliMock).not.toHaveBeenCalled();
  });

  it("accepts app-server transport in routing", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.run(
      createRunInput({
        transport: "app-server",
      }),
    );

    expect(result.outputText).toBe("app-server-output");
    expect(runCodexAppServerMock).toHaveBeenCalledTimes(1);
    expect(runCodexCliMock).not.toHaveBeenCalled();
    const runInput = runCodexAppServerMock.mock.calls[0]?.[0] as { transport?: string };
    expect(runInput.transport).toBe("app-server");
  });

  it("does not fall back from CLI to API on websocket 500 even when API config is present", async () => {
    runCodexCliMock.mockRejectedValueOnce(
      new Error(
        "Codex CLI exited with code 1: ... responses_websocket ... HTTP error: 500 Internal Server Error, url: wss://api.openai.com/v1/responses",
      ),
    );
    const adapter = createCodexRuntimeAdapter();
    await expect(
      adapter.run(
        createRunInput({
          options: {
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        }),
      ),
    ).rejects.toThrow(/responses_websocket/i);
    expect(runCodexCliMock).toHaveBeenCalledTimes(1);
    expect(runCodexAgentApiMock).not.toHaveBeenCalled();
  });

  it("does not fall back when CLI fails but API config is missing", async () => {
    runCodexCliMock.mockRejectedValueOnce(
      new Error(
        "Codex CLI exited with code 1: ... responses_websocket ... HTTP error: 500 Internal Server Error, url: wss://api.openai.com/v1/responses",
      ),
    );
    const adapter = createCodexRuntimeAdapter();

    await expect(adapter.run(createRunInput())).rejects.toThrow(/responses_websocket/i);
    expect(runCodexCliMock).toHaveBeenCalledTimes(1);
    expect(runCodexAgentApiMock).not.toHaveBeenCalled();
  });

  it("resumes sessions using selected transport", async () => {
    const adapter = createCodexRuntimeAdapter();
    await adapter.resume!(
      createRunInput({
        sessionId: "resume-1",
        options: { transport: "agentapi" },
      }) as any,
    );
    expect(runCodexAgentApiMock).toHaveBeenCalledTimes(1);
    const callInput = runCodexAgentApiMock.mock.calls[0][0] as { resume?: boolean };
    expect(callInput.resume).toBe(true);
  });

  it("forks sessions only through app-server transport", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.forkSession!({
      ...createRunInput({
        transport: "app-server",
      }),
      sourceSessionId: "thread-warm-source",
    } as any);

    expect(result.outputText).toBe("app-server-output");
    expect(runCodexAppServerMock).toHaveBeenCalledTimes(1);
    const callInput = runCodexAppServerMock.mock.calls[0][0] as {
      transport?: string;
      sourceSessionId?: string;
      sessionId?: string;
      resume?: boolean;
    };
    expect(callInput.transport).toBe("app-server");
    expect(callInput.sourceSessionId).toBe("thread-warm-source");
    expect(callInput.sessionId).toBeUndefined();
    expect(callInput.resume).toBeUndefined();
  });

  it("rejects fork requests for unsupported Codex transports", async () => {
    const adapter = createCodexRuntimeAdapter();

    await expect(
      adapter.forkSession!({
        ...createRunInput({
          transport: "cli",
        }),
        sourceSessionId: "thread-warm-source",
      } as any),
    ).rejects.toThrow("does not support session fork");
    expect(runCodexCliMock).not.toHaveBeenCalled();
    expect(runCodexAppServerMock).not.toHaveBeenCalled();
  });

  it("validates connection via API validation when transport is legacy 'agentapi'", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "agentapi" as never, // legacy value — backwards compat
      options: { agentApiBaseUrl: "http://localhost:8080", apiKey: "sk-test" },
    });
    expect(result.ok).toBe(true);
    expect(validateCodexAgentApiConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("mentions app-server in unsupported transport validation guidance", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "unsupported" as never,
      options: {},
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('"app-server"');
  });

  it("validates app-server transport via initialize handshake", async () => {
    const adapter = createCodexRuntimeAdapter();
    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "app-server" as never,
      options: { codexCliPath: "codex" },
    });

    expect(result.ok).toBe(true);
    expect(appServerInitializeMock).toHaveBeenCalledTimes(1);
    expect(terminateCodexAppServerProcessMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe app-server cli paths during CLI validation before spawning app-server", async () => {
    probeCodexCliMock.mockReturnValueOnce({
      ok: false,
      error: "Unsafe Codex CLI path contains Windows shell metacharacters",
    });
    const adapter = createCodexRuntimeAdapter();

    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "app-server" as never,
      options: { codexCliPath: "codex&calc" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unsafe Codex CLI path contains Windows shell metacharacters");
    expect(spawnCodexAppServerProcessMock).not.toHaveBeenCalled();
  });

  it("returns install/auth hint when app-server initialize handshake fails", async () => {
    const adapter = createCodexRuntimeAdapter();
    const handshakeError = new Error("unauthorized");
    (handshakeError as unknown as { codexErrorInfo: Record<string, unknown> }).codexErrorInfo = {
      category: "auth",
      adapterCode: "CODEX_AUTH_ERROR",
      httpStatusCode: 401,
    };
    appServerInitializeMock.mockRejectedValueOnce(handshakeError);

    const result = await adapter.validateConnection!({
      runtimeId: "codex",
      providerId: "openai",
      transport: "app-server" as never,
      options: { codexCliPath: "codex" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Install/update Codex CLI");
    expect(result.details).toMatchObject({
      category: "auth",
      adapterCode: "CODEX_AUTH_ERROR",
    });
  });

  it("returns built-in model list when dynamic discovery is unavailable", async () => {
    const adapter = createCodexRuntimeAdapter();
    const models = await adapter.listModels!({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
    });
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ]);
    expect(models[0]?.metadata).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    });
  });

  it("uses Codex app-server model discovery for CLI transport", async () => {
    listCodexAppServerModelsMock.mockResolvedValueOnce([
      {
        id: "gpt-5.4",
        label: "GPT-5.4 (CLI)",
        supportsStreaming: true,
        metadata: {
          supportsEffort: true,
          supportedEffortLevels: ["minimal", "medium", "high"],
        },
      },
    ]);
    const adapter = createCodexRuntimeAdapter();

    const models = await adapter.listModels!({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: "cli",
    });

    expect(models).toEqual([
      {
        id: "gpt-5.4",
        label: "GPT-5.4 (CLI)",
        supportsStreaming: true,
        metadata: {
          supportsEffort: true,
          supportedEffortLevels: ["minimal", "medium", "high"],
        },
      },
    ]);
    expect(listCodexAppServerModelsMock).toHaveBeenCalledTimes(1);
  });

  it("uses API model discovery when API transport is selected", async () => {
    listCodexAgentApiModelsMock.mockResolvedValueOnce([
      {
        id: "gpt-5.4-mini",
      },
    ]);
    const adapter = createCodexRuntimeAdapter();

    const models = await adapter.listModels!({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: "api",
      options: {
        baseUrl: "https://runtime.example.com",
        apiKey: "sk-test",
      },
    });

    expect(models).toEqual([
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        supportsStreaming: true,
        metadata: {
          supportsEffort: true,
          supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
        },
      },
    ]);
    expect(listCodexAgentApiModelsMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to built-in model list when CLI app-server discovery fails", async () => {
    listCodexAppServerModelsMock.mockRejectedValueOnce(new Error("app-server unavailable"));
    const adapter = createCodexRuntimeAdapter();

    const models = await adapter.listModels!({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      transport: "cli",
    });

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ]);
  });
});
