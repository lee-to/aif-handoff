import { Hono } from "hono";
import {
  createParticipant,
  deactivateParticipant,
  findTaskById,
  listParticipants,
  resetParticipantPassword,
  updateParticipant,
  type ParticipantMutationResult,
} from "@aif/data";
import { getEnv, logger, type AuditActor } from "@aif/shared";
import { broadcast } from "../ws.js";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import { jsonValidator, queryValidator } from "../middleware/zodValidator.js";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  createParticipantSchema,
  listParticipantsQuerySchema,
  resetParticipantPasswordSchema,
  updateParticipantSchema,
} from "../schemas.js";

const log = logger("participants-route");

function actorFromRequest(auth: ReturnType<typeof getParticipantAuth>): AuditActor {
  if (auth.session) {
    return {
      kind: "participant",
      id: auth.session.participant.id,
      displayNameSnapshot: auth.session.participant.displayName,
    };
  }
  return {
    kind: "system",
    id: null,
    displayNameSnapshot: "System",
  };
}

function mutationError(result: Extract<ParticipantMutationResult, { ok: false }>) {
  switch (result.code) {
    case "not_found":
      return {
        status: 404 as const,
        body: { error: "Participant not found", code: result.code },
      };
    case "duplicate_username":
      return {
        status: 409 as const,
        body: { error: "Username is already in use", code: result.code },
      };
    case "final_active_admin":
      return {
        status: 409 as const,
        body: { error: "The final active administrator cannot be changed", code: result.code },
      };
    case "inactive_participant":
      return {
        status: 409 as const,
        body: { error: "Participant is inactive", code: result.code },
      };
    case "invalid_current_password":
      return {
        status: 403 as const,
        body: { error: "Current password is incorrect", code: result.code },
      };
    case "invalid_input":
      return {
        status: 400 as const,
        body: { error: "Invalid participant input", code: result.code },
      };
  }
}

function broadcastParticipant(
  type: "participant:created" | "participant:updated" | "participant:deactivated",
  participant: Extract<ParticipantMutationResult, { ok: true }>["participant"],
  actor: AuditActor,
): void {
  broadcast({ type, payload: { participant, actor } });
}

export const participantsRouter = new Hono<ParticipantApiEnv>();

participantsRouter.use("*", requireRole("admin"));
participantsRouter.use("*", async (c, next) => {
  if (!getEnv().PARTICIPANTS_MODE_ENABLED) {
    return c.json(
      { error: "Participants Mode is disabled", code: "participants_mode_disabled" },
      409,
    );
  }
  await next();
});

participantsRouter.get("/", queryValidator(listParticipantsQuerySchema), (c) => {
  const { includeInactive } = c.req.valid("query");
  return c.json(listParticipants({ includeInactive }));
});

participantsRouter.post("/", jsonValidator(createParticipantSchema), async (c) => {
  const input = c.req.valid("json");
  const actor = actorFromRequest(getParticipantAuth(c));
  try {
    const result = await createParticipant(input, actor);
    if (!result.ok) {
      const error = mutationError(result);
      return c.json(error.body, error.status);
    }
    log.info(
      { action: "create", participantId: result.participant.id, actorId: actor.id },
      "Participant administration action completed",
    );
    broadcastParticipant("participant:created", result.participant, actor);
    return c.json(result.participant, 201);
  } catch (error) {
    log.error({ error, action: "create", actorId: actor.id }, "Participant creation failed");
    return c.json(
      { error: "Participant persistence failed", code: "participant_store_error" },
      500,
    );
  }
});

participantsRouter.patch("/:id", jsonValidator(updateParticipantSchema), (c) => {
  const participantId = c.req.param("id");
  const input = c.req.valid("json");
  const actor = actorFromRequest(getParticipantAuth(c));
  try {
    const result = updateParticipant(participantId, input, actor);
    if (!result.ok) {
      const error = mutationError(result);
      return c.json(error.body, error.status);
    }
    log.info(
      { action: "update", participantId, actorId: actor.id },
      "Participant administration action completed",
    );
    broadcastParticipant("participant:updated", result.participant, actor);
    if ((result.revokedSessionCount ?? 0) > 0) {
      broadcast({ type: "auth:session_revoked", payload: { participantId } });
    }
    return c.json(result.participant);
  } catch (error) {
    log.error(
      { error, action: "update", participantId, actorId: actor.id },
      "Participant update failed",
    );
    return c.json(
      { error: "Participant persistence failed", code: "participant_store_error" },
      500,
    );
  }
});

participantsRouter.post("/:id/deactivate", (c) => {
  const participantId = c.req.param("id");
  const actor = actorFromRequest(getParticipantAuth(c));
  try {
    const result = deactivateParticipant(participantId, actor);
    if (!result.ok) {
      const error = mutationError(result);
      return c.json(error.body, error.status);
    }
    log.info(
      { action: "deactivate", participantId, actorId: actor.id },
      "Participant administration action completed",
    );
    broadcastParticipant("participant:deactivated", result.participant, actor);
    broadcast({ type: "auth:session_revoked", payload: { participantId } });
    for (const taskId of result.affectedTaskIds ?? []) {
      const task = findTaskById(taskId);
      if (task) {
        broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(task) });
      }
    }
    return c.json(result.participant);
  } catch (error) {
    log.error(
      { error, action: "deactivate", participantId, actorId: actor.id },
      "Participant deactivation failed",
    );
    return c.json(
      { error: "Participant persistence failed", code: "participant_store_error" },
      500,
    );
  }
});

participantsRouter.post(
  "/:id/reset-password",
  jsonValidator(resetParticipantPasswordSchema),
  async (c) => {
    const participantId = c.req.param("id");
    const { password } = c.req.valid("json");
    const actor = actorFromRequest(getParticipantAuth(c));
    try {
      const result = await resetParticipantPassword(participantId, password, actor);
      if (!result.ok) {
        const error = mutationError(result);
        return c.json(error.body, error.status);
      }
      log.info(
        { action: "reset_password", participantId, actorId: actor.id },
        "Participant administration action completed",
      );
      broadcastParticipant("participant:updated", result.participant, actor);
      broadcast({ type: "auth:session_revoked", payload: { participantId } });
      return c.json({ ok: true, participant: result.participant });
    } catch (error) {
      log.error(
        { error, action: "reset_password", participantId, actorId: actor.id },
        "Participant password reset failed",
      );
      return c.json(
        { error: "Participant persistence failed", code: "participant_store_error" },
        500,
      );
    }
  },
);
