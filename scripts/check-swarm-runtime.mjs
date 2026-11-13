import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

// Run with node --import tsx scripts/check-swarm-runtime.mjs /path/to/built/ai-factory.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const factory = resolve(process.argv[2] ?? join(root, "node_modules/ai-factory"));
const load = (file) => import(pathToFileURL(file).href);
const { SwarmStore } = await load(join(factory, "dist/core/swarm/store.js"));
const { SwarmEngine } = await load(join(factory, "dist/core/swarm/engine.js"));
const { serveSwarm } = await load(join(factory, "dist/core/swarm/api.js"));
const project = await mkdtemp(join(tmpdir(), "aif-swarm-integration-"));
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
git("init");
await writeFile(join(project, "README.md"), "Isolated integration probe\n");
await writeFile(join(project, ".gitignore"), ".ai-factory/swarm/\nhandoff.sqlite*\n");
git("add", "README.md", ".gitignore");
git(
  "-c",
  "user.name=Swarm Probe",
  "-c",
  "user.email=probe@localhost",
  "commit",
  "-m",
  "test fixture",
);
const token = randomBytes(32).toString("hex");
Object.assign(process.env, {
  AIF_SWARM_OWNER_TOKEN: token,
  AIF_SWARM_LOG_LEVEL: "silent",
  LOG_LEVEL: "error",
  DATABASE_URL: join(project, "handoff.sqlite"),
  PARTICIPANTS_MODE_ENABLED: "false",
  AIF_SWARM_CONTROL_PLANE_ENABLED: "true",
  SWARM_RUNTIME_TOKEN: token,
});
const store = await SwarmStore.open(project);
let runtime, handoff;
const checked = [];
const check = (name) => {
  checked.push(name);
  console.log(`PASS ${name}`);
};
try {
  const engine = new SwarmEngine(store, project);
  // Real HTTP/SQLite/runtime startup, but no scheduler tick or model invocation.
  runtime = await serveSwarm(engine, 0, AbortSignal.timeout(60000), 600000);
  process.env.SWARM_RUNTIME_URL = runtime.url;
  const data = await load(join(root, "packages/data/src/index.ts"));
  const localProject = data.createProject({ name: "Live integration probe", rootPath: project });
  assert(localProject);
  process.env.SWARM_PROJECT_ID = localProject.id;
  const { resetEnvCache } = await load(join(root, "packages/shared/src/env.ts"));
  resetEnvCache();
  const { swarmRouter } = await load(join(root, "packages/api/src/routes/swarm.ts"));
  const { createParticipantAuthMiddleware } = await load(
    join(root, "packages/api/src/middleware/participantAuth.ts"),
  );
  const { swarmSnapshotSchema, swarmEventSchema, readSwarmSse } = await load(
    join(root, "packages/shared/src/index.ts"),
  );
  const app = new Hono();
  app.use("*", createParticipantAuthMiddleware());
  app.route("/swarm", swarmRouter);
  const listening = new Promise((resolve) => {
    handoff = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, resolve);
  });
  const address = await listening;
  const base = `http://127.0.0.1:${address.port}/swarm`;
  async function call(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const json = await response.json();
    assert.equal(response.status, body ? 202 : 200, `${path}: ${JSON.stringify(json)}`);
    return json;
  }
  assert.equal((await call("/connection")).enabled, true);
  assert.deepEqual((await call("/runs")).runs, []);
  const input = {
    command_id: randomUUID(),
    goal: "Integration probe",
    acceptance_criteria: ["Wire protocol works"],
    agent_limit: 1,
    budget_tokens: 10000,
    checks: [["node", "--version"]],
    provider: "codex",
    policy: "integration",
  };
  const created = await call("/runs", input);
  assert.equal(created.run_id, (await call("/runs", input)).run_id);
  assert.equal((await call("/runs")).runs.length, 1);
  check("create through Handoff and durable idempotency");
  const initial = await engine.get(created.run_id);
  for (let i = 0; i < 10; i++) {
    const historical = await engine.create(
      { ...initial.spec, goal: `History probe ${i}` },
      initial.baseRef,
    );
    await store.mutate(project, historical.id, (run) => {
      run.startedAt = 1700000000000 + Math.floor(i / 2);
      run.messages = Array.from({ length: 80 }, (_, index) => ({
        id: String(index),
        sender: "fixture",
        topic: "history",
        body: "x".repeat(16000),
      }));
    });
    await engine.control(historical.id, "cancel");
  }
  const historicalBody = await (
    await fetch(`${runtime.url}/v1/swarm/runs`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).text();
  assert(Buffer.byteLength(historicalBody) > 10000000);
  const listHistory = store.list.bind(store);
  store.list = async () => {
    throw new Error("Summary/create must not load full history");
  };
  let cursor;
  const historyIds = [];
  do {
    const page = await call(
      `/runs?limit=3&search=HISTORY&status=cancelled${cursor ? `&cursor=${cursor}` : ""}`,
    );
    assert(page.runs.length <= 3);
    historyIds.push(...page.runs.map((run) => run.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(historyIds.length, 10);
  assert.equal(new Set(historyIds).size, 10);
  const afterHistory = { ...input, command_id: randomUUID(), goal: "Create after large history" };
  const fresh = await call("/runs", afterHistory);
  assert.equal(fresh.run_id, (await call("/runs", afterHistory)).run_id);
  await call(`/runs/${fresh.run_id}/cancel`, { command_id: randomUUID(), confirmed: true });
  store.list = listHistory;
  check("bounded global search/paging and create over >10MB history without loading snapshots");
  const id = created.run_id;
  const snapshot = swarmSnapshotSchema.parse(await call(`/runs/${id}`));
  assert.equal(snapshot.run.project_id, localProject.id);
  assert.equal(snapshot.run.budget_tokens, 10000);
  assert.equal(snapshot.run.cost_usd, null);
  check("nonempty list and atomic snapshot normalization");
  const control = { command_id: randomUUID(), confirmed: true };
  await call(`/runs/${id}/pause`, control);
  const paused = await call(`/runs/${id}`);
  assert.equal(paused.run.status, "paused");
  await call(`/runs/${id}/pause`, control);
  assert.equal((await call(`/runs/${id}`)).sequence, paused.sequence);
  check("pause and duplicate control without a second event");
  const replay = await call(`/runs/${id}/events?after=${snapshot.sequence}`);
  assert.equal(replay.events.length, 1);
  assert.equal(swarmEventSchema.parse(replay.events[0]).type, "run.paused");
  for (let attempt = 0; attempt < 2; attempt++) {
    const abort = new AbortController();
    let received = false;
    try {
      const response = await fetch(`${base}/runs/${id}/events/stream?after=${snapshot.sequence}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      for await (const frame of readSwarmSse(response.body)) {
        const event = swarmEventSchema.parse(JSON.parse(frame));
        assert.equal(event.sequence, snapshot.sequence + 1);
        assert.equal(event.type, "run.paused");
        received = true;
        break;
      }
    } finally {
      abort.abort();
    }
    assert(received, "Replay must deliver a complete event");
  }
  check("SSE replay after disconnect and reconnect");
  await call(`/runs/${id}/resume`, { command_id: randomUUID(), confirmed: true });
  assert.equal((await call(`/runs/${id}`)).run.status, "running");
  await call(`/runs/${id}/cancel`, { command_id: randomUUID(), confirmed: true });
  assert.equal((await call(`/runs/${id}`)).run.status, "cancelled");
  check("resume and cancel");
  const second = await call("/runs", { ...input, command_id: randomUUID() });
  // Seed completed task evidence in the Runtime test fixture, without running a model.
  await store.mutate(project, second.run_id, (run) => {
    run.planned = true;
    run.tasks.push({
      id: "probe-task",
      title: "Probe",
      description: "Fixture",
      acceptanceCriteria: ["Fixture"],
      dependsOn: [],
      depth: 0,
      priority: 0,
      status: "done",
      attempts: 0,
    });
  });
  await engine.complete(second.run_id, true, "Fixture verification");
  const approval = (await call(`/runs/${second.run_id}`)).approvals[0];
  const decision = {
    command_id: randomUUID(),
    confirmed: true,
    decision: "approve",
    reason: "Probe verified",
  };
  await call(`/runs/${second.run_id}/approvals/${approval.id}/decision`, decision);
  await call(`/runs/${second.run_id}/approvals/${approval.id}/decision`, decision);
  assert.equal((await call(`/runs/${second.run_id}`)).run.status, "completed");
  check("completion approval and response-loss retry on terminal run");
  const runs = (await call("/runs")).runs;
  assert(runs.every((run) => run.active_agents === 0));
  const audit = data.listAuditEvents({}).filter((event) => event.entityType === "swarm_run");
  assert(audit.some((event) => event.action === "swarm.create.accepted"));
  assert(audit.some((event) => event.action === "swarm.decision.accepted"));
  assert(!JSON.stringify(audit).includes(token));
  check("Handoff audit and no agents started");
  console.log(`${checked.length} live checks passed; model inference was not run.`);
} finally {
  if (handoff)
    await new Promise((resolve) => {
      handoff.close(resolve);
      handoff.closeAllConnections();
    });
  if (runtime) await runtime.close();
  await store.close();
  await rm(project, { recursive: true, force: true });
}
