import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  swarmSnapshotSchema,
  swarmEventSchema,
  createSwarmRunSchema,
  swarmControlSchema,
} from "../swarm.js";
import { readSwarmSse } from "../swarmSse.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../docs/swarm-v1.snapshot.json", import.meta.url), "utf8"),
);
const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
      controller.close();
    },
  });
const collect = async (chunks: string[]) => {
  const result: string[] = [];
  for await (const data of readSwarmSse(stream(chunks))) result.push(data);
  return result;
};

describe("Swarm v1 compatibility contract", () => {
  it("accepts the published browser fixture and preserves unknown cost as null", () => {
    expect(swarmSnapshotSchema.parse(fixture).run.cost_usd).toBeNull();
  });
  it("rejects incompatible versions, missing snapshot data and invalid metrics", () => {
    expect(swarmSnapshotSchema.safeParse({ ...fixture, schema_version: 2 }).success).toBe(false);
    expect(swarmSnapshotSchema.safeParse({ ...fixture, tasks: undefined }).success).toBe(false);
    expect(
      swarmSnapshotSchema.safeParse({ ...fixture, run: { ...fixture.run, token_total: -1 } })
        .success,
    ).toBe(false);
  });
  it("requires explicit confirmation and prevents injecting project or actor into creation", () => {
    expect(swarmControlSchema.safeParse({ command_id: crypto.randomUUID() }).success).toBe(false);
    expect(
      createSwarmRunSchema.safeParse({
        command_id: crypto.randomUUID(),
        goal: "clean docs",
        acceptance_criteria: ["links pass"],
        agent_limit: 5,
        budget_tokens: 1000000,
        checks: [["npm", "test"]],
        provider: "codex",
        policy: "integration",
        project_id: "injected",
      }).success,
    ).toBe(false);
    expect(swarmEventSchema.safeParse(null).success).toBe(false);
  });
  it("validates native agent limits, token budgets, providers and explicit checks", () => {
    const input = {
      command_id: crypto.randomUUID(),
      goal: "Check links",
      acceptance_criteria: ["Links pass"],
      agent_limit: 5,
      budget_tokens: 1000000,
      checks: [["npm", "test"]],
      provider: "codex",
      policy: "integration",
    };
    expect(createSwarmRunSchema.safeParse(input).success).toBe(true);
    for (const change of [
      { agent_limit: 6 },
      { budget_tokens: 0 },
      { budget_tokens: 1.5 },
      { checks: [] },
      { checks: [[""]] },
      { provider: "unknown" },
    ]) {
      expect(createSwarmRunSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
});

describe("Swarm SSE framing", () => {
  it("handles chunk boundaries, CRLF, comments, event names and multiline data", async () => {
    expect(
      await collect([
        ": ping\r\nid: 1\r\nevent: swarm\r\nda",
        'ta: {"message":\r',
        '\ndata: "привет"}\r\n\r\n',
        "data: two\n\n",
      ]),
    ).toEqual(['{"message":\n"привет"}', "two"]);
  });
  it("does not dispatch a truncated event and bounds the frame size", async () => {
    expect(await collect(["data: incomplete"])).toEqual([]);
    await expect(collect(["x".repeat(1_000_001)])).rejects.toThrow("size limit");
    await expect(collect([`data: ${"x".repeat(1_000_001)}\n\n`])).rejects.toThrow("size limit");
  });
  it("cancels the upstream reader when a consumer disconnects", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _event of readSwarmSse(source)) break;
    expect(cancelled).toBe(true);
  });
});
