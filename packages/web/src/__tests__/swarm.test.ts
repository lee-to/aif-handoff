import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SwarmEventBuffer,
  SwarmReplayGapError,
  swarmRetryDelay,
  swarmTaskHierarchy,
  swarmTaskLayers,
} from "../lib/swarm";
import type { SwarmEvent, SwarmTask } from "@aif/shared/browser";

function event(sequence: number): SwarmEvent {
  return {
    schema_version: 1,
    sequence,
    event_id: `event-${sequence}`,
    run_id: "run-1",
    type: "task.created",
    timestamp: "2026-11-10T09:00:00Z",
    actor: { id: null, role: "lead" },
    task_id: null,
    agent_id: null,
    payload: {},
  };
}
afterEach(() => vi.useRealTimers());
describe("Swarm replay cursor", () => {
  it("replays missed events exactly once after disconnect", () => {
    const history = new SwarmEventBuffer("run-1");
    expect(history.accept(event(1))).toBe(true);
    expect(history.accept(event(2))).toBe(true);
    expect(history.accept(event(1))).toBe(false);
    expect(history.accept(event(2))).toBe(false);
    expect(history.accept(event(3))).toBe(true);
    expect(history.after).toBe(3);
    expect(history.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });
  it("requires snapshot reconciliation for gaps, foreign runs and reused event IDs", () => {
    const history = new SwarmEventBuffer("run-1");
    history.accept(event(1));
    expect(() => history.accept(event(3))).toThrow(SwarmReplayGapError);
    expect(() => history.accept({ ...event(2), run_id: "other" })).toThrow(SwarmReplayGapError);
    expect(() => history.accept({ ...event(2), event_id: "event-1" })).toThrow(SwarmReplayGapError);
    expect(history.after).toBe(1);
    history.reset(20);
    expect(history.events).toEqual([]);
    expect(history.accept(event(21))).toBe(true);
  });
  it("bounds displayed history while keeping its durable replay cursor", () => {
    const history = new SwarmEventBuffer("run-1");
    for (let sequence = 1; sequence <= 600; sequence++) history.accept(event(sequence));
    expect(history.after).toBe(600);
    expect(history.events).toHaveLength(500);
    expect(history.events[0].sequence).toBe(101);
  });
  it("aborts retry waits immediately when the view is closed", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const waiting = swarmRetryDelay(abort.signal, 10000);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    await swarmRetryDelay(abort.signal, 10000);
    const next = swarmRetryDelay(new AbortController().signal, 100);
    await vi.advanceTimersByTimeAsync(100);
    await next;
  });
});

describe("Swarm graph relations", () => {
  const task = (
    id: string,
    depends_on: string[] = [],
    parent_id: string | null = null,
  ): SwarmTask => ({
    id,
    title: id,
    depends_on,
    parent_id,
    status: "queued",
    agent_id: null,
    blocked_reason: null,
    result: null,
    git_ref: null,
    tests: [],
    duration_ms: null,
  });
  it("keeps parent-child relationships out of dependency ordering", () => {
    const tasks = [
      task("child", [], "parent"),
      task("parent", ["prerequisite"]),
      task("prerequisite"),
    ];
    expect(swarmTaskLayers(tasks).layers.map((layer) => layer.map((entry) => entry.id))).toEqual([
      ["child", "prerequisite"],
      ["parent"],
    ]);
    expect(swarmTaskHierarchy(tasks).map((entry) => [entry.task.id, entry.ancestors])).toEqual([
      ["parent", []],
      ["child", ["parent"]],
      ["prerequisite", []],
    ]);
  });
  it("handles missing parents and cycles without infinite recursion", () => {
    const tasks = [
      task("a", ["b"], "b"),
      task("b", ["a"], "a"),
      task("orphan", ["unknown"], "unknown"),
    ];
    expect(swarmTaskLayers(tasks).cyclic).toBe(true);
    expect(swarmTaskHierarchy(tasks)).toHaveLength(3);
    expect(swarmTaskLayers([])).toEqual({ layers: [], cyclic: false });
  });
});
