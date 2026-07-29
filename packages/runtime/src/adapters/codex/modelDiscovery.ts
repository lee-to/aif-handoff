import { RuntimeTransport, type RuntimeModel, type RuntimeModelListInput } from "../../types.js";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  parseCodexRuntimeModel,
} from "./modelDiscovery/modelCatalog.js";
import {
  buildCodexAppServerDiscoveryEnv,
  resolveDiscoveryExecutable,
  spawnCodexAppServer,
  terminateProcess,
} from "./modelDiscovery/process.js";
import { connectJsonRpcClient, sleep } from "./modelDiscovery/rpc.js";
import type {
  CodexModelDiscoveryLogger,
  CodexModelDiscoveryStartupDeps,
  JsonRpcClient,
} from "./modelDiscovery/types.js";

const DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_APP_SERVER_STARTUP_ATTEMPTS = 3;
const DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS = 150;
const MAX_MODEL_LIST_PAGES = 10;

export { buildCodexAppServerDiscoveryEnv, enrichCodexDiscoveredModels, getDefaultCodexModels };
export type { CodexModelDiscoveryLogger };

export async function startCodexAppServerWithRetry(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
  deps: CodexModelDiscoveryStartupDeps = {
    spawnCodexAppServer,
    connectJsonRpcClient,
    terminateProcess,
    sleep,
  },
): Promise<{
  attempt: number;
  launch: Awaited<ReturnType<typeof spawnCodexAppServer>>;
  client: JsonRpcClient;
  executablePath: string;
}> {
  const executablePath = resolveDiscoveryExecutable(input);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_APP_SERVER_STARTUP_ATTEMPTS; attempt += 1) {
    const launch = deps.spawnCodexAppServer(input);
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        hasConfiguredCliPath:
          typeof asRecord(input.options).codexCliPath === "string" ||
          typeof process.env.CODEX_CLI_PATH === "string",
        projectRoot: input.projectRoot ?? null,
        attempt,
        maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
      },
      "DEBUG [runtime:codex] Starting Codex app-server model discovery over stdio",
    );

    try {
      const client = await deps.connectJsonRpcClient(launch, {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        requestTimeoutMs: DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
        logger,
      });

      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "aif-runtime-codex-model-discovery",
            title: "AIF Runtime Codex Model Discovery",
            version: "1.0",
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
      );
      await client.notify?.("initialized");

      logger?.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.CLI,
          attempt,
          maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
        },
        "DEBUG [runtime:codex] Codex app-server initialize handshake completed",
      );

      return {
        attempt,
        launch,
        client,
        executablePath,
      };
    } catch (error) {
      const details = launch.stderrTail.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      const startupError = new Error(details ? `${message} (${details})` : message);
      lastError = startupError;
      await deps.terminateProcess(launch);

      if (attempt < DEFAULT_APP_SERVER_STARTUP_ATTEMPTS) {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport: input.transport ?? RuntimeTransport.CLI,
            executablePath,
            attempt,
            maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
            error: startupError.message,
            retryDelayMs: DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS,
            nextAttempt: attempt + 1,
          },
          "WARN [runtime:codex] Codex app-server stdio startup failed, retrying",
        );
        await deps.sleep(DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS);
        continue;
      }

      logger?.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.CLI,
          executablePath,
          attempt,
          maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
          error: startupError.message,
        },
        "ERROR [runtime:codex] Codex app-server startup retries exhausted",
      );
    }
  }

  throw (
    lastError ??
    new Error("Codex app-server startup failed before initialize handshake could complete")
  );
}

export async function listCodexAppServerModels(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
): Promise<RuntimeModel[]> {
  const startup = await startCodexAppServerWithRetry(input, logger);
  const { client, launch, executablePath } = startup;

  try {
    const discovered: RuntimeModel[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const result = asRecord(
        await client.request(
          "model/list",
          {
            cursor,
            includeHidden: false,
            limit: 100,
          },
          DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
        ),
      );
      const models = Array.isArray(result.data) ? result.data : [];
      for (const model of models) {
        const parsed = parseCodexRuntimeModel(model);
        if (parsed) {
          discovered.push(parsed);
        }
      }

      cursor = readString(result.nextCursor);
      if (!cursor) {
        break;
      }
    }

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        modelCount: discovered.length,
      },
      "DEBUG [runtime:codex] Fetched model list from Codex app-server",
    );

    return enrichCodexDiscoveredModels(discovered);
  } catch (error) {
    const details = launch.stderrTail.join("").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(details ? `${message} (${details})` : message);
  } finally {
    try {
      client.close();
    } finally {
      await terminateProcess(launch);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
