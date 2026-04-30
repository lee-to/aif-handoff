import type { CodexAppServerMethod, CodexAppServerRequestMap } from "./protocol.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import { JsonlRpcClient, type JsonlRpcClientLogger } from "./jsonlRpcClient.js";

export interface CodexAppServerClientOptions {
  runtimeId: string;
  profileId?: string | null;
  transport?: string;
  requestTimeoutMs?: number;
  logger?: JsonlRpcClientLogger;
}

export class CodexAppServerClient {
  private readonly rpcClient: JsonlRpcClient;
  private readonly logger?: JsonlRpcClientLogger;
  private readonly runtimeId: string;
  private readonly profileId: string | null;
  private readonly transport: string;
  private readonly requestTimeoutMs: number;
  private initializePromise: Promise<InitializeResponse> | null = null;

  constructor(rpcClient: JsonlRpcClient, options: CodexAppServerClientOptions) {
    this.rpcClient = rpcClient;
    this.logger = options.logger;
    this.runtimeId = options.runtimeId;
    this.profileId = options.profileId ?? null;
    this.transport = options.transport ?? "app-server";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  }

  async initialize(
    params: CodexAppServerRequestMap["initialize"]["params"],
  ): Promise<InitializeResponse> {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.initializePromise = this.request("initialize", params).then(async (result) => {
      await this.rpcClient.notify("initialized");
      this.logger?.debug?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
        },
        "DEBUG [runtime:codex] App-server initialize handshake completed",
      );
      return result;
    });
    return this.initializePromise;
  }

  async listModels(
    params: CodexAppServerRequestMap["model/list"]["params"],
  ): Promise<CodexAppServerRequestMap["model/list"]["result"]> {
    await this.initialize({
      clientInfo: {
        name: "aif-runtime-codex-client",
        title: "AIF Runtime Codex Client",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });
    return await this.request("model/list", params);
  }

  async startThread(
    params: CodexAppServerRequestMap["thread/start"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/start"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/start", params);
  }

  async listThreads(
    params: CodexAppServerRequestMap["thread/list"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/list"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/list", params);
  }

  async forkThread(
    params: CodexAppServerRequestMap["thread/fork"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/fork"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/fork", params);
  }

  async readThread(
    params: CodexAppServerRequestMap["thread/read"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/read"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/read", params);
  }

  async resumeThread(
    params: CodexAppServerRequestMap["thread/resume"]["params"],
  ): Promise<CodexAppServerRequestMap["thread/resume"]["result"]> {
    await this.ensureInitialized();
    return await this.request("thread/resume", params);
  }

  async startTurn(
    params: CodexAppServerRequestMap["turn/start"]["params"],
  ): Promise<CodexAppServerRequestMap["turn/start"]["result"]> {
    await this.ensureInitialized();
    return await this.request("turn/start", params);
  }

  async interruptTurn(
    params: CodexAppServerRequestMap["turn/interrupt"]["params"],
  ): Promise<CodexAppServerRequestMap["turn/interrupt"]["result"]> {
    await this.ensureInitialized();
    return await this.request("turn/interrupt", params);
  }

  close(reason = "client closed"): void {
    this.rpcClient.close(reason);
  }

  private async ensureInitialized(): Promise<InitializeResponse> {
    return await this.initialize({
      clientInfo: {
        name: "aif-runtime-codex-client",
        title: "AIF Runtime Codex Client",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });
  }

  private async request<M extends CodexAppServerMethod>(
    method: M,
    params: CodexAppServerRequestMap[M]["params"],
  ): Promise<CodexAppServerRequestMap[M]["result"]> {
    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method,
      },
      "DEBUG [runtime:codex] App-server RPC request",
    );

    return (await this.rpcClient.request(method, params, this.requestTimeoutMs)) as
      | CodexAppServerRequestMap[M]["result"]
      | Promise<CodexAppServerRequestMap[M]["result"]>;
  }
}
