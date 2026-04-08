import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { RuntimeTransport, type RuntimeModel, type RuntimeModelListInput } from "../../types.js";

export interface CodexModelDiscoveryLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

const IS_WINDOWS = process.platform === "win32";
const moduleRequire = createRequire(import.meta.url);
const CODEX_SDK_NPM_NAME = "@openai/codex-sdk";
const CODEX_NPM_NAME = "@openai/codex";
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};
const CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number];

const DEFAULT_CODEX_MODELS: RuntimeModel[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...CODEX_EFFORT_LEVELS],
    },
  },
];

const KNOWN_CODEX_MODELS = new Map(
  DEFAULT_CODEX_MODELS.map((model) => [model.id.toLowerCase(), cloneRuntimeModel(model)]),
);

const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "npm_",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_",
  "FORCE_COLOR",
  "NO_COLOR",
];

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface AppServerLaunchContext {
  process: ChildProcess;
  stderr: string[];
}

class JsonRpcWebSocketClient {
  private readonly socket: WebSocket;
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(message: JsonRpcMessage) => void> = [];
  private nextId = 0;
  private closed = false;
  private closeError: Error | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("error", () => {
      this.handleClose(new Error("Codex app-server websocket errored"));
    });
    socket.addEventListener("close", () => {
      this.handleClose(new Error("Codex app-server websocket closed"));
    });
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = ++this.nextId;
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    );

    while (true) {
      const message = await this.nextMessage(timeoutMs);

      if (typeof message.method === "string" && message.id != null) {
        this.socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: "Unsupported server-initiated request during Codex model discovery",
            },
          }),
        );
        continue;
      }

      if (message.id !== id) {
        continue;
      }

      if (message.error) {
        throw new Error(message.error.message ?? `Codex app-server request failed (${method})`);
      }

      return message.result;
    }
  }

  async close(): Promise<void> {
    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.close();
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await toMessageText(data);
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        this.enqueueMessage(entry);
      }
      return;
    }

    this.enqueueMessage(parsed);
  }

  private enqueueMessage(candidate: unknown) {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const message = candidate as JsonRpcMessage;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }

    this.queue.push(message);
  }

  private nextMessage(timeoutMs: number): Promise<JsonRpcMessage> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }

    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("Codex app-server websocket closed"));
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("Timed out waiting for Codex app-server response"));
      }, timeoutMs);

      const waiter = (message: JsonRpcMessage) => {
        clearTimeout(timer);
        resolve(message);
      };

      this.waiters.push(waiter);
    });
  }

  private handleClose(error: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({
        error: {
          message: error.message,
        },
      });
    }
  }
}

export function getDefaultCodexModels(): RuntimeModel[] {
  return DEFAULT_CODEX_MODELS.map(cloneRuntimeModel);
}

export function enrichCodexDiscoveredModels(models: RuntimeModel[]): RuntimeModel[] {
  const enriched: RuntimeModel[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const id = readString(candidate.id);
    if (!id) {
      continue;
    }

    const normalizedId = id.toLowerCase();
    if (seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);

    const known = KNOWN_CODEX_MODELS.get(normalizedId);
    const metadata = mergeModelMetadata(known?.metadata, candidate.metadata);
    enriched.push({
      id,
      label: candidate.label ?? known?.label,
      supportsStreaming: candidate.supportsStreaming ?? known?.supportsStreaming ?? true,
      ...(metadata ? { metadata } : {}),
    });
  }

  return enriched;
}

export async function listCodexAppServerModels(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
): Promise<RuntimeModel[]> {
  const executablePath = resolveDiscoveryExecutable(input);
  const listenPort = await reservePort();
  const listenUrl = `ws://127.0.0.1:${listenPort}`;
  const launch = spawnCodexAppServer(
    executablePath,
    listenUrl,
    input.projectRoot,
    buildDiscoveryEnv(input),
  );
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
    },
    "DEBUG [runtime:codex] Starting Codex app-server model discovery",
  );

  try {
    const client = await connectJsonRpcClient(listenUrl, launch, 5_000);
    try {
      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "aif-runtime-codex-model-discovery",
            version: "1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        5_000,
      );

      const discovered: RuntimeModel[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 10; page += 1) {
        const result = asRecord(
          await client.request(
            "model/list",
            {
              cursor,
              includeHidden: false,
              limit: 100,
            },
            5_000,
          ),
        );
        const models = Array.isArray(result.data) ? result.data : [];
        for (const model of models) {
          const parsed = toRuntimeModel(model);
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
    } finally {
      await client.close();
    }
  } catch (error) {
    const details = launch.stderr.join("").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(details ? `${message} (${details})` : message);
  } finally {
    terminateProcess(launch.process);
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

function cloneRuntimeModel(model: RuntimeModel): RuntimeModel {
  return {
    ...model,
    ...(model.metadata ? { metadata: structuredCloneCompatible(model.metadata) } : {}),
  };
}

function structuredCloneCompatible(value: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  return cloned;
}

function mergeModelMetadata(
  known: Record<string, unknown> | undefined,
  discovered: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...(known ? structuredCloneCompatible(known) : {}),
    ...(discovered ? structuredCloneCompatible(discovered) : {}),
  };

  const supportedEffortLevels =
    normalizeEffortLevels(merged.supportedEffortLevels) ??
    normalizeSupportedReasoningEfforts(merged.supportedReasoningEfforts);
  if (supportedEffortLevels) {
    merged.supportedEffortLevels = supportedEffortLevels;
    merged.supportsEffort = true;
  } else {
    delete merged.supportedEffortLevels;
    if (merged.supportsEffort !== true) {
      delete merged.supportsEffort;
    }
  }

  const defaultEffort =
    normalizeEffortLevel(merged.defaultEffort) ??
    normalizeEffortLevel(merged.defaultReasoningEffort);
  if (defaultEffort) {
    merged.defaultEffort = defaultEffort;
  } else {
    delete merged.defaultEffort;
  }
  delete merged.defaultReasoningEffort;
  delete merged.supportedReasoningEfforts;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeEffortLevel(value: unknown): CodexEffortLevel | null {
  return typeof value === "string" && CODEX_EFFORT_LEVELS.includes(value as CodexEffortLevel)
    ? (value as CodexEffortLevel)
    : null;
}

function normalizeEffortLevels(value: unknown): CodexEffortLevel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<CodexEffortLevel>();
  for (const entry of value) {
    const normalized = normalizeEffortLevel(entry);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return unique.size > 0 ? [...unique] : undefined;
}

function normalizeSupportedReasoningEfforts(value: unknown): CodexEffortLevel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<CodexEffortLevel>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = normalizeEffortLevel((entry as Record<string, unknown>).reasoningEffort);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return unique.size > 0 ? [...unique] : undefined;
}

function resolveDiscoveryExecutable(input: RuntimeModelListInput): string {
  const options = asRecord(input.options);
  const configuredCliPath =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);

  if (configuredCliPath) {
    return configuredCliPath;
  }

  if (input.transport === RuntimeTransport.SDK) {
    return findBundledCodexBinary();
  }

  return "codex";
}

function findBundledCodexBinary(): string {
  const { platform, arch } = process;
  let targetTriple: string | null = null;

  switch (platform) {
    case "linux":
    case "android":
      targetTriple =
        arch === "x64"
          ? "x86_64-unknown-linux-musl"
          : arch === "arm64"
            ? "aarch64-unknown-linux-musl"
            : null;
      break;
    case "darwin":
      targetTriple =
        arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null;
      break;
    case "win32":
      targetTriple =
        arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : null;
      break;
    default:
      targetTriple = null;
  }

  if (!targetTriple) {
    throw new Error(`Unsupported platform for bundled Codex binary: ${platform} (${arch})`);
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`Unsupported Codex target triple: ${targetTriple}`);
  }

  const codexSdkPackageJsonPath = moduleRequire.resolve(`${CODEX_SDK_NPM_NAME}/package.json`);
  const codexSdkRequire = createRequire(codexSdkPackageJsonPath);
  const codexPackageJsonPath = codexSdkRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
  const codexRequire = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
  const vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
  const binaryName = IS_WINDOWS ? "codex.exe" : "codex";
  return path.join(vendorRoot, targetTriple, "codex", binaryName);
}

function buildDiscoveryEnv(input: RuntimeModelListInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  const options = asRecord(input.options);
  const apiKeyEnvVar =
    readString(options.apiKeyEnvVar) ?? readString(input.apiKeyEnvVar) ?? "OPENAI_API_KEY";
  const apiKey =
    readString(input.apiKey) ??
    readString(options.apiKey) ??
    readString(process.env[apiKeyEnvVar]) ??
    readString(process.env.OPENAI_API_KEY);
  if (apiKey) {
    env[apiKeyEnvVar] = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const baseUrl =
    readString(input.baseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.OPENAI_BASE_URL) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
    env.CODEX_BASE_URL = baseUrl;
  }

  return env;
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve loopback port for Codex app-server"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnCodexAppServer(
  executablePath: string,
  listenUrl: string,
  cwd: string | undefined,
  env: Record<string, string>,
): AppServerLaunchContext {
  const args = ["app-server", "--listen", listenUrl];
  const childProcess =
    IS_WINDOWS && !executablePath.toLowerCase().endsWith(".exe")
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", [executablePath, ...args].map(quoteIfNeeded).join(" ")],
          {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executablePath, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

  const stderr: string[] = [];
  childProcess.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(String(chunk));
    if (stderr.length > 25) {
      stderr.shift();
    }
  });

  return { process: childProcess, stderr };
}

async function connectJsonRpcClient(
  listenUrl: string,
  launch: AppServerLaunchContext,
  timeoutMs: number,
): Promise<JsonRpcWebSocketClient> {
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("Global WebSocket is not available in this Node runtime");
  }

  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    if (launch.process.exitCode != null) {
      const details = launch.stderr.join("").trim();
      throw new Error(
        details
          ? `Codex app-server exited early with code ${launch.process.exitCode}: ${details}`
          : `Codex app-server exited early with code ${launch.process.exitCode}`,
      );
    }

    try {
      const socket = await openWebSocket(WebSocketCtor, listenUrl, 1_000);
      return new JsonRpcWebSocketClient(socket);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(100);
    }
  }

  throw new Error(
    lastError
      ? `Timed out connecting to Codex app-server: ${lastError}`
      : "Timed out connecting to Codex app-server",
  );
}

async function openWebSocket(
  WebSocketCtor: typeof WebSocket,
  listenUrl: string,
  timeoutMs: number,
): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocketCtor(listenUrl);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const handleOpen = () => {
      settle(() => resolve(socket));
    };

    const handleError = () => {
      settle(() => reject(new Error("Codex app-server websocket connection failed")));
    };

    const handleClose = () => {
      settle(() => reject(new Error("Codex app-server websocket closed before initialization")));
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          socket.close();
        } catch {
          // ignored
        }
        reject(new Error("Timed out opening Codex app-server websocket"));
      });
    }, timeoutMs);

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
  });
}

async function toMessageText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return await data.text();
  }
  return "";
}

function toRuntimeModel(value: unknown): RuntimeModel | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const model = value as Record<string, unknown>;
  const id = readString(model.model) ?? readString(model.id);
  if (!id) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  const description = readString(model.description);
  if (description) {
    metadata.description = description;
  }

  const supportedEffortLevels = normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
  if (supportedEffortLevels) {
    metadata.supportsEffort = true;
    metadata.supportedEffortLevels = supportedEffortLevels;
  }

  const defaultEffort = normalizeEffortLevel(model.defaultReasoningEffort);
  if (defaultEffort) {
    metadata.defaultEffort = defaultEffort;
  }

  if (typeof model.hidden === "boolean") {
    metadata.hidden = model.hidden;
  }
  if (typeof model.isDefault === "boolean") {
    metadata.isDefault = model.isDefault;
  }
  if (typeof model.supportsPersonality === "boolean") {
    metadata.supportsPersonality = model.supportsPersonality;
  }
  if (Array.isArray(model.inputModalities)) {
    metadata.inputModalities = model.inputModalities.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (readString(model.upgrade)) {
    metadata.upgrade = model.upgrade;
  }
  if (model.upgradeInfo && typeof model.upgradeInfo === "object") {
    metadata.upgradeInfo = model.upgradeInfo;
  }
  if (model.availabilityNux && typeof model.availabilityNux === "object") {
    metadata.availabilityNux = model.availabilityNux;
  }

  return {
    id,
    label: readString(model.displayName) ?? undefined,
    supportsStreaming: true,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function terminateProcess(process: ChildProcess) {
  if (process.exitCode != null) {
    return;
  }

  try {
    process.kill();
  } catch {
    // ignored
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
