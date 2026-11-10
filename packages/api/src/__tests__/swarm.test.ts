import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects, type SwarmSnapshot } from "@aif/shared";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const db = { current: createTestDb() };
const config = vi.hoisted(() => ({
  SWARM_RUNTIME_URL: "http://localhost:4010" as string | undefined,
  SWARM_RUNTIME_TOKEN: "runtime-private-credential-123456",
  SWARM_PROJECT_ID: "project-1",
  SWARM_OPERATOR_IDS: "",
}));
vi.mock("@aif/shared", async (original) => {
  const actual = await original<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.validateEnv({}),
      ...config,
      PARTICIPANTS_MODE_ENABLED: true,
      PARTICIPANT_SESSION_COOKIE_NAME: "session",
      PARTICIPANT_ALLOWED_ORIGINS: ["http://localhost:5180"],
    }),
  };
});
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const { createParticipant, createParticipantSession, revokeParticipantSession, listAuditEvents } =
  await import("@aif/data");
const { participantAuth } = await import("../middleware/participantAuth.js");
const { participantCsrf } = await import("../middleware/csrf.js");
const { participantRouteAuthorization } = await import("../middleware/requireRole.js");
const { swarmRouter } = await import("../routes/swarm.js");
const { getSwarmSnapshot, streamSwarmEvents, sanitizeSwarmValue } =
  await import("../services/swarm.js");
const fixture: SwarmSnapshot = JSON.parse(
  readFileSync(new URL("../../../../docs/swarm-v1.snapshot.json", import.meta.url), "utf8"),
);
const runtimeFetch = vi.fn<typeof fetch>();
const app = new Hono<ParticipantApiEnv>();
app.use("*", participantAuth);
app.use("*", participantRouteAuthorization());
app.use("*", participantCsrf());
app.route("/swarm", swarmRouter);
let owner: Record<string, string>;
let viewer: Record<string, string>;
let operator: Record<string, string>;

async function credentials(role: "admin" | "member") {
  const result = await createParticipant({
    username: crypto.randomUUID(),
    displayName: role,
    password: "long-test-password",
    role,
  });
  if (!result.ok) throw new Error("Participant creation failed");
  const session = createParticipantSession(result.participant.id, { ttlMs: 60_000 });
  if (!session) throw new Error("Session creation failed");
  return {
    id: result.participant.id,
    headers: {
      cookie: `session=${session.token}`,
      "x-csrf-token": session.csrfToken,
      origin: "http://localhost:5180",
      "content-type": "application/json",
    },
  };
}
function post(path: string, body: unknown, headers = owner) {
  return app.request(`/swarm${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
function event(sequence: number, payload: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: `event-${sequence}`,
    sequence,
    run_id: "run-1",
    type: "run.started",
    timestamp: "2026-11-10T09:00:00Z",
    actor: { id: null, role: "lead" },
    task_id: null,
    agent_id: null,
    payload,
  };
}
const json = (data: unknown) => Response.json(data);
const sse = (...events: unknown[]) =>
  new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

beforeEach(async () => {
  db.current = createTestDb();
  config.SWARM_RUNTIME_URL = "http://localhost:4010";
  config.SWARM_PROJECT_ID = "project-1";
  const admin = await credentials("admin");
  const member = await credentials("member");
  const ops = await credentials("member");
  owner = admin.headers;
  viewer = member.headers;
  operator = ops.headers;
  config.SWARM_OPERATOR_IDS = ops.id;
  db.current
    .insert(projects)
    .values({ id: "project-1", name: "Project", rootPath: "/tmp/swarm-project" })
    .run();
  runtimeFetch.mockReset();
  runtimeFetch.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json({
        schema_version: 1,
        command_id: body.command_id,
        run_id: "run-1",
        accepted: true,
      });
    }
    if (path.endsWith("/events/stream")) return sse(event(1), event(2));
    if (path.endsWith("/events")) return json({ schema_version: 1, events: [event(1), event(2)] });
    if (path.endsWith("/runs")) return json({ schema_version: 1, runs: [fixture.run] });
    return json(fixture);
  });
  vi.stubGlobal("fetch", runtimeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Swarm control plane API", () => {
  it("requires authentication and exposes only safe connection configuration", async () => {
    expect((await app.request("/swarm/runs")).status).toBe(401);
    const response = await app.request("/swarm/connection", { headers: viewer });
    expect(await response.json()).toEqual({
      enabled: true,
      projectId: "project-1",
      role: "viewer",
      schemaVersion: 1,
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
    config.SWARM_RUNTIME_URL = undefined;
    expect(await (await app.request("/swarm/connection", { headers: owner })).json()).toMatchObject(
      { enabled: false },
    );
    expect((await app.request("/swarm/runs", { headers: owner })).status).toBe(503);
  });
  it("lists runs and validates snapshots with project fencing", async () => {
    const response = await app.request("/swarm/runs", { headers: viewer });
    expect(await response.json()).toMatchObject({ runs: [{ id: "run-1" }] });
    const [url, init] = runtimeFetch.mock.calls[0];
    expect(String(url)).toContain("project_id=project-1");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${config.SWARM_RUNTIME_TOKEN}`,
    );
    expect(await getSwarmSnapshot("run-1")).toMatchObject(fixture);
    config.SWARM_PROJECT_ID = "another-project";
    expect((await app.request("/swarm/runs/run-1", { headers: viewer })).status).toBe(404);
  });
  it("creates runs using the stored project path and audits intent and acceptance", async () => {
    const command_id = crypto.randomUUID();
    const response = await post("/runs", {
      command_id,
      goal: "Clean docs",
      acceptance_criteria: ["Links pass"],
      worker_limit: 2,
      budget_usd: null,
      policy: "integration",
    });
    expect(response.status).toBe(202);
    const init = runtimeFetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      project_id: "project-1",
      project_path: "/tmp/swarm-project",
      schema_version: 1,
      actor: { role: "owner" },
    });
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(command_id);
    expect(listAuditEvents({}).map((entry) => entry.action)).toContain("swarm.create.accepted");
  });
  it.each(["pause", "resume", "cancel"])(
    "denies viewers and allows operators to %s with stable command IDs",
    async (action) => {
      const body = { command_id: crypto.randomUUID(), confirmed: true };
      expect((await post(`/runs/run-1/${action}`, body, viewer)).status).toBe(403);
      expect(runtimeFetch).not.toHaveBeenCalled();
      expect((await post(`/runs/run-1/${action}`, body, operator)).status).toBe(202);
      expect((await post(`/runs/run-1/${action}`, body, operator)).status).toBe(202);
      const calls = runtimeFetch.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(calls.map(([, init]) => new Headers(init?.headers).get("idempotency-key"))).toEqual([
        body.command_id,
        body.command_id,
      ]);
      expect(listAuditEvents({}).map((entry) => entry.action)).toContain("swarm.command.denied");
    },
  );
  it("restricts approvals to owners and validates approval membership", async () => {
    const body = {
      command_id: crypto.randomUUID(),
      confirmed: true,
      decision: "approve",
      reason: "Tests passed",
    };
    const path = "/runs/run-1/approvals/approval-1/decision";
    expect((await post(path, body, operator)).status).toBe(403);
    expect((await post(path, body)).status).toBe(202);
    expect((await post("/runs/run-1/approvals/unknown/decision", body)).status).toBe(409);
    const sent = runtimeFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      run_id: "run-1",
      approval_id: "approval-1",
    });
  });
  it("records Lead instructions through Runtime without storing their text in audit", async () => {
    const response = await post(
      "/runs/run-1/instructions",
      {
        command_id: crypto.randomUUID(),
        confirmed: true,
        instruction: "Check broken links first",
      },
      operator,
    );
    expect(response.status).toBe(202);
    const audit = listAuditEvents({}).filter((entry) => entry.entityType === "swarm_run");
    expect(audit.map((entry) => entry.action)).toContain("swarm.instruction.accepted");
    expect(JSON.stringify(audit)).not.toContain("broken links");
  });
  it("validates confirmations, IDs, cursors and CSRF before dispatch", async () => {
    expect((await post("/runs/run-1/pause", { command_id: crypto.randomUUID() })).status).toBe(400);
    expect(
      (await post("/runs/run-1/pause", { command_id: "invalid", confirmed: true })).status,
    ).toBe(400);
    expect(
      (await app.request("/swarm/runs/run-1/events?after=-1", { headers: viewer })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/swarm/runs/run-1/events/stream", {
          headers: { ...viewer, "last-event-id": "oops" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/runs/run-1/pause",
          { command_id: crypto.randomUUID(), confirmed: true },
          { ...owner, "x-csrf-token": "bad" },
        )
      ).status,
    ).toBe(403);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
  it.each([
    [404, 404],
    [409, 409],
    [410, 409],
    [401, 403],
    [403, 403],
    [500, 503],
  ])("maps Runtime HTTP %i to %i without echoing upstream errors", async (status, expected) => {
    runtimeFetch.mockResolvedValue(new Response("secret upstream body", { status }));
    const response = await app.request("/swarm/runs", { headers: viewer });
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("secret upstream body");
  });
  it("rejects contract drift, foreign run/approval IDs and mismatched command acknowledgements", async () => {
    runtimeFetch.mockResolvedValueOnce(json({ ...fixture, schema_version: 2 }));
    await expect(getSwarmSnapshot("run-1")).rejects.toMatchObject({ code: "swarm_contract_error" });
    runtimeFetch.mockResolvedValueOnce(
      json({ ...fixture, approvals: [{ ...fixture.approvals[0], run_id: "foreign" }] }),
    );
    await expect(getSwarmSnapshot("run-1")).rejects.toMatchObject({ code: "swarm_contract_error" });
    runtimeFetch.mockResolvedValueOnce(
      json({ ...fixture, run: { ...fixture.run, id: "foreign" } }),
    );
    await expect(getSwarmSnapshot("run-1")).rejects.toMatchObject({ code: "swarm_contract_error" });
    runtimeFetch.mockResolvedValueOnce(json(fixture)).mockResolvedValueOnce(
      json({
        schema_version: 1,
        command_id: crypto.randomUUID(),
        run_id: "run-1",
        accepted: true,
      }),
    );
    expect(
      (await post("/runs/run-1/pause", { command_id: crypto.randomUUID(), confirmed: true }))
        .status,
    ).toBe(502);
    expect(listAuditEvents({}).map((entry) => entry.action)).toContain("swarm.pause.unconfirmed");
  });
  it("handles unreachable Runtime and forbids redirects and insecure remote URLs", async () => {
    runtimeFetch.mockRejectedValueOnce(new Error(config.SWARM_RUNTIME_TOKEN));
    const response = await app.request("/swarm/runs", { headers: viewer });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(config.SWARM_RUNTIME_TOKEN);
    expect(runtimeFetch.mock.calls[0][1]?.redirect).toBe("error");
    config.SWARM_RUNTIME_URL = "http://untrusted.example";
    expect((await app.request("/swarm/connection", { headers: owner })).status).toBe(503);
  });
  it("redacts nested secrets, known credentials, assignments and private keys before exposure", () => {
    const result = sanitizeSwarmValue({
      token: "random-value",
      nested: [
        {
          api_key: "also-private",
          note: `auth=${config.SWARM_RUNTIME_TOKEN} password=hunter2 sk-abcdefghijk`,
        },
      ],
      private_key: "-----BEGIN PRIVATE KEY-----\nvery-private\n-----END PRIVATE KEY-----",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /random-value|also-private|hunter2|sk-abcdefghijk|very-private/,
    );
    expect(JSON.stringify(result)).not.toContain(config.SWARM_RUNTIME_TOKEN);
  });
  it("replays events, deduplicates SSE and supports Last-Event-ID", async () => {
    const replay = await app.request("/swarm/runs/run-1/events?after=0", { headers: viewer });
    expect(await replay.json()).toMatchObject({ events: [{ sequence: 1 }, { sequence: 2 }] });
    const response = await app.request("/swarm/runs/run-1/events/stream", {
      headers: { ...viewer, "last-event-id": "1" },
    });
    const text = await response.text();
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(text).not.toContain('"sequence":1');
    expect(text).toContain('"sequence":2');
    expect(runtimeFetch.mock.calls.at(-1)?.[0]).toContain("after=1");
  });
  it("fails closed on SSE gaps, foreign events and wrong content type", async () => {
    async function collect() {
      for await (const _event of streamSwarmEvents("run-1", 0, new AbortController().signal)) {
        /* consume */
      }
    }
    runtimeFetch.mockResolvedValueOnce(sse(event(2)));
    await expect(collect()).rejects.toMatchObject({ code: "swarm_conflict" });
    runtimeFetch.mockResolvedValueOnce(sse({ ...event(1), run_id: "foreign" }));
    await expect(collect()).rejects.toMatchObject({ code: "swarm_contract_error" });
    runtimeFetch.mockResolvedValueOnce(json({ events: [] }));
    await expect(collect()).rejects.toMatchObject({ code: "swarm_contract_error" });
  });

  it("terminates an open stream after the participant session is revoked", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    runtimeFetch.mockResolvedValueOnce(json(fixture)).mockImplementationOnce(async (_url, init) => {
      upstreamSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            upstreamSignal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const response = await app.request("/swarm/runs/run-1/events/stream", { headers: owner });
    const body = response.text();
    revokeParticipantSession(owner.cookie.slice("session=".length));
    await vi.advanceTimersByTimeAsync(10_000);
    await body;
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
