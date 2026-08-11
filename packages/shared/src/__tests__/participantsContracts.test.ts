import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_KINDS,
  EXECUTION_OWNERS,
  PARTICIPANT_ROLES,
  type AuthSessionState,
  type ParticipantBroadcastPayload,
  type TaskExecutorHistoryEntry,
  type TaskOwnershipBroadcastPayload,
  type WsEvent,
} from "../browser.js";

describe("browser-safe participant contracts", () => {
  it("exports the stable participant, owner, and actor enums", () => {
    expect(PARTICIPANT_ROLES).toEqual(["admin", "member"]);
    expect(EXECUTION_OWNERS).toEqual(["ai", "human"]);
    expect(AUDIT_ACTOR_KINDS).toEqual(["participant", "agent", "system", "anonymous"]);
  });

  it("supports authenticated session and collaboration payloads without Node-only fields", () => {
    const session = {
      participantsModeEnabled: true,
      authenticated: true,
      participant: {
        id: "participant-1",
        displayName: "Alice",
        role: "admin",
        active: true,
      },
      csrfToken: "opaque-browser-token",
      expiresAt: "2026-07-25T12:00:00.000Z",
    } satisfies AuthSessionState;
    const actor = {
      kind: "participant",
      id: "participant-1",
      displayNameSnapshot: "Alice",
    } as const;
    const history = {
      id: "history-1",
      taskId: "task-1",
      taskTitleSnapshot: "Task",
      ownershipRevision: 1,
      executionOwner: "human",
      assignees: [
        {
          participantId: "participant-1",
          displayName: "Alice",
          role: "admin",
          active: true,
        },
      ],
      statusSnapshot: "planning",
      actor,
      reason: null,
      createdAt: "2026-07-24T12:00:00.000Z",
    } satisfies TaskExecutorHistoryEntry;
    const participantPayload = {
      participant: session.participant,
      actor,
    } satisfies ParticipantBroadcastPayload;
    const ownershipPayload = {
      taskId: history.taskId,
      projectId: "project-1",
      ownership: {
        executionOwner: history.executionOwner,
        ownershipRevision: history.ownershipRevision,
        assignees: history.assignees,
      },
      actor,
    } satisfies TaskOwnershipBroadcastPayload;
    const events = [
      { type: "participant:updated", payload: participantPayload },
      { type: "task:handoff", payload: ownershipPayload },
    ] satisfies WsEvent[];

    expect(events.map((event) => event.type)).toEqual(["participant:updated", "task:handoff"]);
  });
});
