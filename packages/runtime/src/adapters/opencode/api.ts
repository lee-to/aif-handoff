import type {
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import { classifyOpenCodeRuntimeError } from "./errors.js";

export interface OpenCodeApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_SERVER_USERNAME = "opencode";
const SENSITIVE_OPTION_KEYS = new Set([
  "apiKey",
  "apikey",
  "api_key",
  "secret",
  "password",
  "serverPassword",
]);

interface OpenCodeSessionResponse {
  id: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  version?: {
    modelID?: string;
    providerID?: string;
  };
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIso(value: unknown): string {
  if (typeof value === "number") {
    const ms = value > 9_999_999_999 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

const OPENCODE_EFFORT_LEVELS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const);

type OpenCodeEffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeOpenCodeEffort(value: unknown): OpenCodeEffortLevel | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (OPENCODE_EFFORT_LEVELS.has(trimmed as OpenCodeEffortLevel)) {
      return trimmed as OpenCodeEffortLevel;
    }
  }
  return null;
}

function stripSensitiveOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return options;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!SENSITIVE_OPTION_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function resolveBaseUrl(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  const baseUrl =
    readString(options.baseUrl) ?? readString(process.env.OPENCODE_BASE_URL) ?? DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

function resolveServerUsername(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return (
    readString(options.serverUsername) ??
    readString(process.env.OPENCODE_SERVER_USERNAME) ??
    DEFAULT_SERVER_USERNAME
  );
}

function resolveServerPassword(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.serverPassword) ?? readString(process.env.OPENCODE_SERVER_PASSWORD);
}

function resolveBearerToken(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.apiKey) ?? readString(options.bearerToken);
}

function resolveRequestTimeoutMs(
  input: RuntimeRunInput | RuntimeConnectionValidationInput,
): number {
  const options = asRecord(input.options);
  const raw = options.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if ("execution" in input) {
    const exec = (input as RuntimeRunInput).execution;
    if (
      typeof exec?.runTimeoutMs === "number" &&
      Number.isFinite(exec.runTimeoutMs) &&
      exec.runTimeoutMs > 0
    ) {
      return Math.floor(exec.runTimeoutMs);
    }
  }
  return 30_000;
}

function mergeHeaderMaps(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const optionsHeaders = asRecord(asRecord((input as RuntimeRunInput).options).headers);
  for (const [key, value] of Object.entries(optionsHeaders)) {
    if (typeof value === "string") merged[key] = value;
  }

  if ("headers" in input && input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value === "string") merged[key] = value;
    }
  }

  return merged;
}

function buildHeaders(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });

  const password = resolveServerPassword(input);
  if (password) {
    const username = resolveServerUsername(input);
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    headers.set("Authorization", `Basic ${encoded}`);
  }

  const bearer = resolveBearerToken(input);
  if (bearer) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }

  const mergedHeaders = mergeHeaderMaps(input);
  for (const [key, value] of Object.entries(mergedHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

function parseModelSelection(input: RuntimeRunInput): { providerID?: string; modelID?: string } {
  const model = readString(input.model);
  if (!model) return {};

  if (model.includes("/")) {
    const delimiter = model.indexOf("/");
    const providerID = model.slice(0, delimiter).trim();
    const modelID = model.slice(delimiter + 1).trim();
    if (providerID && modelID) {
      return { providerID, modelID };
    }
  }

  const options = asRecord(input.options);
  const providerID =
    readString(options.providerID) ??
    readString(options.defaultProviderID) ??
    readString(process.env.OPENCODE_PROVIDER_ID);

  return {
    providerID: providerID ?? undefined,
    modelID: model,
  };
}

function extractTextFromParts(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    const type = readString(record.type);
    if (type && type !== "text") continue;
    const text = readString(record.text) ?? readString(record.content);
    if (text) texts.push(text);
  }
  return texts.join("\n\n").trim();
}

function mapSession(
  session: OpenCodeSessionResponse,
  profileId: string | null | undefined,
  runtimeId: string,
  providerId: string,
): RuntimeSession {
  const modelID = readString(asRecord(session.version).modelID);
  const provider = readString(asRecord(session.version).providerID) ?? providerId;

  return {
    id: session.id,
    runtimeId,
    providerId: provider,
    profileId: profileId ?? null,
    model: modelID ?? null,
    title: readString(session.title),
    createdAt: toIso(asRecord(session.time).created),
    updatedAt: toIso(asRecord(session.time).updated),
    metadata: { raw: session },
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

async function requestJson<T>(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
    logger?: OpenCodeApiLogger;
    logMessage?: string;
  },
): Promise<T> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}${options.path}`;
  const timeoutMs = options.timeoutMs ?? resolveRequestTimeoutMs(input as RuntimeRunInput);

  options.logger?.debug?.(
    {
      runtimeId: (input as RuntimeRunInput).runtimeId ?? null,
      method: options.method,
      path: options.path,
      timeoutMs,
      baseUrl,
      options: stripSensitiveOptions(asRecord((input as RuntimeRunInput).options)),
    },
    options.logMessage ?? "OpenCode request",
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: buildHeaders(input),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`OpenCode HTTP ${response.status} at ${options.path}: ${bodyText}`);
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    throw classifyOpenCodeRuntimeError(error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createOpenCodeSession(
  input: RuntimeRunInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession> {
  const payload = await requestJson<OpenCodeSessionResponse>(input, {
    method: "POST",
    path: "/session",
    body: {
      title: input.prompt.slice(0, 80),
    },
    logger,
    logMessage: "Creating OpenCode session",
  });

  return mapSession(payload, input.profileId, input.runtimeId, input.providerId ?? "opencode");
}

export async function runOpenCodeApi(
  input: RuntimeRunInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeRunResult> {
  const runtimeId = input.runtimeId;
  const providerId = input.providerId ?? "opencode";

  logger?.info?.(
    {
      runtimeId,
      profileId: input.profileId ?? null,
      transport: "api",
      sessionId: input.sessionId ?? null,
      baseUrl: resolveBaseUrl(input),
      model: input.model ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "OpenCode run started",
  );

  const session = input.sessionId
    ? await getOpenCodeSession(
        {
          runtimeId,
          providerId,
          profileId: input.profileId,
          projectRoot: input.projectRoot,
          sessionId: input.sessionId,
          options: input.options,
          headers: input.headers,
        },
        logger,
      )
    : await createOpenCodeSession(input, logger);

  const activeSession = session ?? (await createOpenCodeSession(input, logger));
  const modelSelection = parseModelSelection(input);
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: input.prompt }],
  };

  if (modelSelection.modelID) {
    body.model = {
      providerID: modelSelection.providerID,
      modelID: modelSelection.modelID,
    };
  }

  if (input.systemPrompt) {
    body.system = input.systemPrompt;
  }

  if (input.execution?.systemPromptAppend) {
    body.system = body.system
      ? `${String(body.system)}\n\n${input.execution.systemPromptAppend}`
      : input.execution.systemPromptAppend;
  }

  if (input.execution?.outputSchema) {
    body.outputFormat = {
      type: "json_schema",
      name: "response",
      schema: input.execution.outputSchema,
    };
  }

  const options = asRecord(input.options);
  const effort = normalizeOpenCodeEffort(options.reasoningEffort);
  if (effort) {
    body.reasoningEffort = effort;
  }

  // bypassPermissions parity: OpenCode resolves `agent` to the user's
  // configured default (or the built-in `build` agent). When the caller
  // requests a permission bypass, force `build` so a user-configured
  // restrictive default (e.g. `plan`) cannot block edits. Per-tool
  // "ask" permissions (.env*, external_directory, doom_loop) are still
  // enforced server-side — true parity would require responding to
  // /session/:id/permissions/:permissionID events over SSE.
  if (input.execution?.bypassPermissions) {
    body.agent = "build";
  }

  const messagePayload = await requestJson<{ info?: unknown; parts?: unknown[] }>(input, {
    method: "POST",
    path: `/session/${encodeURIComponent(activeSession.id)}/message`,
    body,
    logger,
    logMessage: "Posting OpenCode session message",
  });

  const parts = Array.isArray(messagePayload.parts) ? messagePayload.parts : [];
  const outputText = extractTextFromParts(parts);
  const event: RuntimeEvent = {
    type: "stream:text",
    timestamp: new Date().toISOString(),
    message: outputText,
    data: {
      sessionId: activeSession.id,
      partCount: parts.length,
    },
  };

  if (outputText.length > 0 && input.execution?.onEvent) {
    input.execution.onEvent(event);
  }

  logger?.info?.(
    {
      runtimeId,
      profileId: input.profileId ?? null,
      sessionId: activeSession.id,
      outputLength: outputText.length,
      eventSent: outputText.length > 0 && Boolean(input.execution?.onEvent),
    },
    "OpenCode run completed",
  );

  return {
    outputText,
    sessionId: activeSession.id,
    session: activeSession,
    events: outputText.length > 0 ? [event] : [],
    raw: messagePayload,
  };
}

export async function listOpenCodeSessions(
  input: RuntimeSessionListInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession[]> {
  const payload = await requestJson<OpenCodeSessionResponse[]>(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId,
      options: input.options,
      headers: input.headers,
    },
    {
      method: "GET",
      path: "/session",
      logger,
      logMessage: "Listing OpenCode sessions",
    },
  );

  const sessions = (Array.isArray(payload) ? payload : []).map((session) =>
    mapSession(session, input.profileId, input.runtimeId, input.providerId ?? "opencode"),
  );

  return input.limit ? sessions.slice(0, input.limit) : sessions;
}

export async function getOpenCodeSession(
  input: RuntimeSessionGetInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession | null> {
  try {
    const payload = await requestJson<OpenCodeSessionResponse>(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId,
        options: input.options,
        headers: input.headers,
      },
      {
        method: "GET",
        path: `/session/${encodeURIComponent(input.sessionId)}`,
        logger,
        logMessage: "Getting OpenCode session",
      },
    );

    if (!payload?.id) {
      return null;
    }

    return mapSession(payload, input.profileId, input.runtimeId, input.providerId ?? "opencode");
  } catch (error) {
    const classified = classifyOpenCodeRuntimeError(error);
    if (classified.adapterCode === "OPENCODE_SESSION_ERROR") {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          sessionId: input.sessionId,
          error: classified.message,
        },
        "OpenCode session not found",
      );
      return null;
    }
    throw classified;
  }
}

export async function listOpenCodeSessionEvents(
  input: RuntimeSessionEventsInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeEvent[]> {
  const payload = await requestJson<Array<{ info?: Record<string, unknown>; parts?: unknown[] }>>(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId,
      options: input.options,
      headers: input.headers,
    },
    {
      method: "GET",
      path: `/session/${encodeURIComponent(input.sessionId)}/message${
        input.limit ? `?limit=${input.limit}` : ""
      }`,
      logger,
      logMessage: "Listing OpenCode session messages",
    },
  );

  const events: RuntimeEvent[] = [];
  for (const message of Array.isArray(payload) ? payload : []) {
    const info = asRecord(message.info);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = extractTextFromParts(parts);
    if (!text) continue;

    events.push({
      type: "session-message",
      timestamp: toIso(info.time),
      level: "info",
      message: text,
      data: {
        id: readString(info.id) ?? undefined,
        role: readString(info.role) ?? "assistant",
      },
    });
  }

  return events;
}

export async function validateOpenCodeApiConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  try {
    const payload = await requestJson<{ healthy?: boolean; version?: string }>(input, {
      method: "GET",
      path: "/global/health",
      logMessage: "Validating OpenCode API connection",
    });

    if (!payload.healthy) {
      return {
        ok: false,
        message: "OpenCode health check failed",
      };
    }

    return {
      ok: true,
      message: `OpenCode API connection validated (version: ${payload.version ?? "unknown"})`,
    };
  } catch (error) {
    throw classifyOpenCodeRuntimeError(error);
  }
}

function extractModelsFromProvider(provider: unknown): RuntimeModel[] {
  const record = asRecord(provider);
  const providerID = readString(record.id) ?? readString(record.providerID) ?? "opencode";
  const modelsValue = record.models;

  if (!Array.isArray(modelsValue)) {
    return [];
  }

  const models: RuntimeModel[] = [];
  for (const model of modelsValue) {
    if (typeof model === "string") {
      models.push({
        id: `${providerID}/${model}`,
        label: `${providerID}/${model}`,
        supportsStreaming: true,
      });
      continue;
    }

    const modelRecord = asRecord(model);
    const modelID = readString(modelRecord.id) ?? readString(modelRecord.modelID);
    if (!modelID) continue;

    models.push({
      id: `${providerID}/${modelID}`,
      label: readString(modelRecord.name) ?? `${providerID}/${modelID}`,
      supportsStreaming: true,
      metadata: {
        providerID,
        modelID,
      },
    });
  }

  return models;
}

export async function listOpenCodeApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
): Promise<RuntimeModel[]> {
  try {
    const payload = await requestJson<{ providers?: unknown[] }>(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId,
        options: (input as RuntimeConnectionValidationInput).options,
      },
      {
        method: "GET",
        path: "/config/providers",
        logMessage: "Listing OpenCode models",
      },
    );

    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    const models = providers.flatMap((provider) => extractModelsFromProvider(provider));

    return models;
  } catch (error) {
    throw classifyOpenCodeRuntimeError(error);
  }
}
