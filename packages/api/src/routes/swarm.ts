import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { appendAuditEvent, findProjectById, resolveParticipantSession } from "@aif/data";
import { getEnv, logger, type AuditActor, type SwarmRole } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";
import { jsonValidator, queryValidator } from "../middleware/zodValidator.js";
import {
  createSwarmRunSchema,
  swarmControlSchema,
  swarmDecisionSchema,
  swarmRunsQuerySchema,
} from "../schemas.js";
import {
  SwarmError,
  swarmConfiguration,
  listSwarmRuns,
  getSwarmSnapshot,
  getSwarmEvents,
  streamSwarmEvents,
  sendSwarmCommand,
  sanitizeSwarmValue,
} from "../services/swarm.js";

const log = logger("swarm-routes");
type SwarmContext = Context<ParticipantApiEnv>;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const runParam = zValidator("param", z.object({ runId: id }));
const approvalParam = zValidator("param", z.object({ runId: id, approvalId: id }));
const cursorQuery = queryValidator(
  z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }),
);

function roleFor(c: SwarmContext): SwarmRole {
  const auth = getParticipantAuth(c);
  if (auth.mode === "disabled" || auth.session?.participant.role === "admin") return "owner";
  const operators = getEnv()
    .SWARM_OPERATOR_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return auth.session && operators.includes(auth.session.participant.id) ? "operator" : "viewer";
}

function actorFor(c: SwarmContext): AuditActor {
  const participant = getParticipantAuth(c).session?.participant;
  return participant
    ? { kind: "participant", id: participant.id, displayNameSnapshot: participant.displayName }
    : { kind: "system", id: null, displayNameSnapshot: "Local owner" };
}

async function command(
  c: SwarmContext,
  input: {
    path: string;
    action: string;
    runId?: string;
    body: Record<string, unknown>;
  },
) {
  const config = swarmConfiguration();
  if (!config) throw new SwarmError("swarm_disabled", 503);
  const actor = actorFor(c);
  const audit = {
    entityType: "swarm_run",
    entityId: input.runId ?? null,
    actor,
    metadata: {
      commandId: input.body.command_id,
      projectId: config.projectId,
      ...(input.action === "decision"
        ? { decision: input.body.decision, reason: sanitizeSwarmValue(input.body.reason) }
        : {}),
    },
  };
  // Persist intent before dispatch so a database failure cannot create unaudited commands.
  appendAuditEvent({ ...audit, action: `swarm.${input.action}.requested` });
  try {
    const result = await sendSwarmCommand(input.path, input.body);
    if (input.runId && result.run_id !== input.runId)
      throw new SwarmError("swarm_contract_error", 502);
    appendAuditEvent({
      ...audit,
      entityId: result.run_id,
      action: `swarm.${input.action}.accepted`,
    });
    log.info(
      { action: input.action, runId: result.run_id, commandId: result.command_id },
      "Swarm command accepted",
    );
    return c.json(result, 202);
  } catch (error) {
    appendAuditEvent({ ...audit, action: `swarm.${input.action}.unconfirmed` });
    throw error;
  }
}

export const swarmRouter = new Hono<ParticipantApiEnv>();
swarmRouter.onError((error, c) => {
  if (error instanceof SwarmError)
    return c.json({ error: error.code, code: error.code }, error.status);
  log.error({ errorType: error.name }, "Swarm request failed");
  return c.json({ error: "Swarm request failed", code: "swarm_unavailable" }, 503);
});

swarmRouter.use("*", async (c, next) => {
  const auth = getParticipantAuth(c);
  if (auth.mode !== "disabled" && !auth.session)
    return c.json({ error: "Authentication required" }, 401);
  if (c.req.method === "POST") {
    const ownerOnly = c.req.path.endsWith("/runs") || c.req.path.endsWith("/decision");
    const role = roleFor(c);
    if (role === "viewer" || (ownerOnly && role !== "owner")) {
      appendAuditEvent({
        action: "swarm.command.denied",
        entityType: "swarm_run",
        actor: actorFor(c),
      });
      return c.json({ error: "Insufficient Swarm permissions", code: "forbidden" }, 403);
    }
  }
  await next();
});

swarmRouter.get("/connection", (c) => {
  const config = swarmConfiguration();
  return c.json({
    enabled: config !== null,
    projectId: config?.projectId ?? null,
    role: roleFor(c),
    schemaVersion: 1,
  });
});
swarmRouter.get("/runs", queryValidator(swarmRunsQuerySchema), async (c) =>
  c.json(await listSwarmRuns(c.req.valid("query"))),
);
swarmRouter.get("/runs/:runId", runParam, async (c) =>
  c.json(await getSwarmSnapshot(c.req.valid("param").runId)),
);

swarmRouter.post("/runs", jsonValidator(createSwarmRunSchema), async (c) => {
  const config = swarmConfiguration();
  if (!config) throw new SwarmError("swarm_disabled", 503);
  const project = findProjectById(config.projectId);
  if (!project) throw new SwarmError("swarm_not_found", 404);
  return command(c, {
    path: "/runs",
    action: "create",
    body: c.req.valid("json"),
  });
});

for (const action of ["pause", "resume", "cancel"] as const) {
  swarmRouter.post(
    `/runs/:runId/${action}`,
    runParam,
    jsonValidator(swarmControlSchema),
    async (c) => {
      const { runId } = c.req.valid("param");
      await getSwarmSnapshot(runId);
      return command(c, {
        path: `/runs/${encodeURIComponent(runId)}/${action}`,
        action,
        runId,
        body: c.req.valid("json"),
      });
    },
  );
}
swarmRouter.post(
  "/runs/:runId/approvals/:approvalId/decision",
  approvalParam,
  jsonValidator(swarmDecisionSchema),
  async (c) => {
    const { runId, approvalId } = c.req.valid("param");
    const snapshot = await getSwarmSnapshot(runId);
    if (!snapshot.approvals.some((approval) => approval.id === approvalId)) {
      throw new SwarmError("swarm_conflict", 409);
    }
    return command(c, {
      path: `/approvals/${encodeURIComponent(approvalId)}/decision`,
      action: "decision",
      runId,
      body: { ...c.req.valid("json"), run_id: runId, approval_id: approvalId },
    });
  },
);

swarmRouter.get("/runs/:runId/events", runParam, cursorQuery, async (c) => {
  const { runId } = c.req.valid("param");
  await getSwarmSnapshot(runId);
  return c.json(await getSwarmEvents(runId, c.req.valid("query").after));
});
swarmRouter.get("/runs/:runId/events/stream", runParam, cursorQuery, async (c) => {
  const { runId } = c.req.valid("param");
  const cursor = c.req.valid("query").after;
  const lastId = c.req.header("last-event-id");
  const parsed = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(lastId ?? cursor);
  if (!parsed.success) return c.json({ error: "Invalid event cursor" }, 400);
  await getSwarmSnapshot(runId);
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const auth = getParticipantAuth(c);
    const heartbeat = setInterval(() => {
      try {
        if (
          auth.mode !== "disabled" &&
          (!auth.sessionToken || !resolveParticipantSession(auth.sessionToken))
        ) {
          abort.abort();
          return;
        }
        void stream.write(": heartbeat\n\n").catch(() => abort.abort());
      } catch {
        log.warn({ runId }, "Closing Swarm stream after authentication store failure");
        abort.abort();
      }
    }, 10_000);
    try {
      for await (const event of streamSwarmEvents(runId, parsed.data, abort.signal)) {
        await stream.writeSSE({
          event: "swarm",
          id: String(event.sequence),
          data: JSON.stringify(event),
        });
      }
    } catch {
      log.debug({ runId }, "Swarm stream disconnected; client will replay from cursor");
    } finally {
      clearInterval(heartbeat);
      abort.abort();
    }
  });
});
