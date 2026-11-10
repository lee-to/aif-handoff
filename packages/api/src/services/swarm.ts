import { z } from "zod";
import { findProjectById } from "@aif/data";
import {
  getEnv,
  logger,
  readSwarmSse,
  redactProviderTextForLogs,
  swarmSnapshotSchema,
  swarmRunSchema,
  swarmEventSchema,
  createSwarmRunSchema,
  type SwarmEvent,
} from "@aif/shared";
import {
  runtimeRunSchema,
  runtimeRunsSchema,
  runtimeEventsSchema,
  runtimeEventSchema,
  runtimeDecisionSchema,
  normalizeSwarmSnapshot,
  normalizeSwarmRun,
  normalizeSwarmEvent,
} from "./swarmContract.js";

const log = logger("swarm-runtime");
type SwarmErrorCode =
  | "swarm_disabled"
  | "swarm_unavailable"
  | "swarm_contract_error"
  | "swarm_not_found"
  | "swarm_conflict"
  | "swarm_forbidden";
export class SwarmError extends Error {
  constructor(
    public code: SwarmErrorCode,
    public status: 400 | 403 | 404 | 409 | 502 | 503,
  ) {
    super(code);
  }
}

export function swarmConfiguration() {
  const env = getEnv();
  if (!env.AIF_SWARM_CONTROL_PLANE_ENABLED) return null;
  if (!env.SWARM_RUNTIME_URL || !env.SWARM_PROJECT_ID || !env.SWARM_RUNTIME_TOKEN) return null;
  const url = new URL(env.SWARM_RUNTIME_URL);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal", "swarm"]);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && localHosts.has(url.hostname)))
  )
    throw new SwarmError("swarm_contract_error", 503);
  return { url: url.origin, projectId: env.SWARM_PROJECT_ID, token: env.SWARM_RUNTIME_TOKEN };
}

export function sanitizeSwarmValue(value: unknown): unknown {
  if (typeof value === "string") {
    const token = getEnv().SWARM_RUNTIME_TOKEN;
    const text = (token ? value.replaceAll(token, "[REDACTED]") : value).replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED]",
    );
    return redactProviderTextForLogs(text);
  }
  if (Array.isArray(value)) return value.map(sanitizeSwarmValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /secret|password|authorization|cookie|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|^token$/i.test(
          key,
        )
          ? "[REDACTED]"
          : sanitizeSwarmValue(entry),
      ]),
    );
  }
  return value;
}

async function runtimeResponse(path: string, init: RequestInit = {}, stream = false) {
  const config = swarmConfiguration();
  if (!config) throw new SwarmError("swarm_disabled", 503);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.token}`);
  headers.set("Accept", stream ? "text/event-stream" : "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  log.debug({ path, method: init.method ?? "GET" }, "Calling Swarm Runtime");
  let response: Response;
  try {
    response = await fetch(`${config.url}/v1/swarm${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(stream ? 45_000 : 10_000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  } catch {
    log.warn({ path }, "Swarm Runtime connection failed");
    throw new SwarmError("swarm_unavailable", 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    log.warn({ path, status: response.status }, "Swarm Runtime rejected request");
    if (response.status === 404) throw new SwarmError("swarm_not_found", 404);
    if (response.status === 409 || response.status === 410)
      throw new SwarmError("swarm_conflict", 409);
    if (response.status === 401 || response.status === 403)
      throw new SwarmError("swarm_forbidden", 403);
    if (response.status === 400) throw new SwarmError("swarm_conflict", 409);
    throw new SwarmError("swarm_unavailable", 503);
  }
  if (stream && !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await response.body?.cancel();
    throw new SwarmError("swarm_contract_error", 502);
  }
  return response;
}

async function runtimeJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await runtimeResponse(path, init);
  try {
    if (!response.body) throw new Error("Missing body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10_000_000) throw new Error("Snapshot exceeds size limit");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return schema.parse(sanitizeSwarmValue(JSON.parse(text)));
  } catch {
    log.warn({ path }, "Invalid Swarm Runtime response");
    throw new SwarmError("swarm_contract_error", 502);
  }
}

function configuredProject() {
  const config = swarmConfiguration();
  if (!config) throw new SwarmError("swarm_disabled", 503);
  const project = findProjectById(config.projectId);
  if (!project) throw new SwarmError("swarm_not_found", 404);
  return project;
}

function snapshotFromRuntime(run: z.infer<typeof runtimeRunSchema>) {
  const project = configuredProject();
  if (run.project !== project.rootPath) throw new SwarmError("swarm_not_found", 404);
  try {
    return swarmSnapshotSchema.parse(normalizeSwarmSnapshot(run, project.id));
  } catch {
    log.warn({ runId: run.id }, "Invalid normalized Swarm snapshot");
    throw new SwarmError("swarm_contract_error", 502);
  }
}
const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

export async function listSwarmRuns() {
  const project = configuredProject();
  const result = await runtimeJson("/runs", runtimeRunsSchema);
  try {
    return {
      schema_version: 1 as const,
      runs: result.runs.map((run) => {
        if (run.project !== project.rootPath) throw new SwarmError("swarm_not_found", 404);
        return swarmRunSchema.parse(normalizeSwarmRun(run, project.id));
      }),
    };
  } catch (error) {
    if (error instanceof SwarmError) throw error;
    log.warn("Invalid normalized Swarm run list");
    throw new SwarmError("swarm_contract_error", 502);
  }
}

export async function getSwarmSnapshot(runId: string) {
  const result = snapshotFromRuntime(await runtimeJson(runPath(runId), runtimeRunSchema));
  if (result.run.id !== runId) {
    throw new SwarmError("swarm_contract_error", 502);
  }
  return result;
}

export async function getSwarmEvents(runId: string, after: number) {
  const result = await runtimeJson(`${runPath(runId)}/events?after=${after}`, runtimeEventsSchema);
  if (result.events.some((event) => event.run_id !== runId))
    throw new SwarmError("swarm_contract_error", 502);
  return {
    schema_version: 1 as const,
    events: result.events.map((event) => swarmEventSchema.parse(normalizeSwarmEvent(event))),
  };
}

export async function* streamSwarmEvents(
  runId: string,
  after: number,
  signal: AbortSignal,
): AsyncGenerator<SwarmEvent> {
  const response = await runtimeResponse(
    `${runPath(runId)}/events/stream?after=${after}`,
    { signal },
    true,
  );
  if (!response.body) throw new SwarmError("swarm_contract_error", 502);
  let sequence = after;
  try {
    for await (const data of readSwarmSse(response.body)) {
      const native = runtimeEventSchema.parse(sanitizeSwarmValue(JSON.parse(data)));
      const event = swarmEventSchema.parse(normalizeSwarmEvent(native));
      if (event.run_id !== runId) throw new SwarmError("swarm_contract_error", 502);
      if (event.sequence <= sequence) continue;
      if (event.sequence !== sequence + 1) throw new SwarmError("swarm_conflict", 409);
      sequence = event.sequence;
      yield event;
    }
  } catch (error) {
    if (error instanceof SwarmError) throw error;
    throw new SwarmError("swarm_contract_error", 502);
  }
}

export async function sendSwarmCommand(path: string, body: Record<string, unknown>) {
  const init = (input: unknown): RequestInit => ({
    method: "POST",
    headers: { "Idempotency-Key": String(body.command_id) },
    body: JSON.stringify(input),
  });
  let runId: string;
  if (path === "/runs") {
    const input = createSwarmRunSchema.parse(body);
    // A Runtime URL/token is bound to one project by deployment, not by request fields.
    await listSwarmRuns();
    const provider = { provider: input.provider, ...(input.model ? { model: input.model } : {}) };
    const native = {
      goal: input.goal,
      acceptanceCriteria: input.acceptance_criteria,
      checks: input.checks,
      lead: provider,
      workers: [provider],
      approval: input.policy,
      limits: {
        maxAgents: input.agent_limit,
        budgetTokens: input.budget_tokens,
        tokensPerAttempt: Math.min(100000, input.budget_tokens),
      },
    };
    runId = snapshotFromRuntime(await runtimeJson(path, runtimeRunSchema, init(native))).run.id;
  } else if (path.startsWith("/approvals/")) {
    runId = String(body.run_id);
    const before = await getSwarmSnapshot(runId);
    const approval = before.approvals.find((entry) => entry.id === body.approval_id);
    const desired = body.decision === "approve" ? "approved" : "rejected";
    if (!approval || (approval.status !== "pending" && approval.status !== desired))
      throw new SwarmError("swarm_conflict", 409);
    // Completion can make a run terminal; reconcile a lost response before retrying.
    if (approval.status === "pending") {
      await runtimeJson(path, runtimeDecisionSchema, init({ decision: body.decision }));
      const after = await getSwarmSnapshot(runId);
      if (after.approvals.find((entry) => entry.id === body.approval_id)?.status !== desired)
        throw new SwarmError("swarm_contract_error", 502);
    }
  } else {
    const expectedRunId = path.split("/")[2];
    const result = snapshotFromRuntime(await runtimeJson(path, runtimeRunSchema, init({})));
    if (result.run.id !== expectedRunId) throw new SwarmError("swarm_contract_error", 502);
    runId = result.run.id;
  }
  log.debug({ path, runId }, "Swarm Runtime command response validated");
  return {
    schema_version: 1 as const,
    command_id: String(body.command_id),
    run_id: runId,
    accepted: true as const,
  };
}
