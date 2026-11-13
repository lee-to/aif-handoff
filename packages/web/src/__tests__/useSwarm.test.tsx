import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmEvent, SwarmSnapshot } from "@aif/shared/browser";
import { api, ApiError } from "../lib/api";
import { useSwarmRun } from "../hooks/useSwarm";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../hooks/useNotificationSettings", () => ({
  useNotificationSettings: () => ({ settings: { desktop: false } }),
}));
const fixture: SwarmSnapshot = JSON.parse(
  readFileSync(resolve("../../docs/swarm-v1.snapshot.json"), "utf8"),
);
function event(sequence: number, type = "task.created"): SwarmEvent {
  return {
    schema_version: 1,
    event_id: `event-${sequence}`,
    sequence,
    run_id: "run-1",
    type,
    timestamp: "2026-11-10T09:01:00Z",
    actor: { id: null, role: "lead" },
    task_id: null,
    agent_id: null,
    payload: {},
  };
}
let receive: (event: SwarmEvent) => void;
let end: () => void;
let signal: AbortSignal;
function start() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = renderHook(() => useSwarmRun("run-1"), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...result, client };
}
beforeEach(() => {
  toast.mockReset();
  vi.spyOn(api, "getSwarmSnapshot").mockResolvedValue(structuredClone(fixture));
  vi.spyOn(api, "getSwarmEvents").mockResolvedValue({
    schema_version: 1,
    events: [event(1), event(2, "approval.requested")],
  });
  vi.spyOn(api, "streamSwarmEvents").mockImplementation(
    async (_runId, _after, abort, callback, onOpen) => {
      signal = abort;
      receive = callback;
      onOpen();
      await new Promise<void>((resolve) => {
        end = resolve;
        abort.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Swarm synchronization", () => {
  it("suppresses historical notifications, deduplicates live events and refreshes snapshots", async () => {
    const { result, unmount, client } = start();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.events).toHaveLength(2);
    expect(toast).not.toHaveBeenCalled();
    act(() => {
      receive(event(3, "run.completed"));
      receive(event(3, "run.completed"));
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(result.current.events).toHaveLength(3);
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["swarm", "run", "run-1"] }),
    );
    unmount();
    expect(signal.aborted).toBe(true);
    client.clear();
  });
  it("marks a closed stream stale and reconnects from its last accepted sequence", async () => {
    const { result, client } = start();
    await waitFor(() => expect(result.current.stale).toBe(false));
    vi.mocked(api.getSwarmSnapshot).mockResolvedValue({ ...fixture, sequence: 3 });
    vi.mocked(api.getSwarmEvents).mockResolvedValue({
      schema_version: 1,
      events: [event(2), event(3, "approval.requested")],
    });
    await act(async () => {
      end();
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    await waitFor(() => expect(api.streamSwarmEvents).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(vi.mocked(api.getSwarmEvents).mock.calls.at(-1)).toEqual(["run-1", 2]);
    expect(vi.mocked(api.streamSwarmEvents).mock.calls.at(-1)?.[1]).toBe(3);
    expect(result.current.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(toast).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it("reconciles expired event cursors through a fresh snapshot", async () => {
    vi.mocked(api.getSwarmEvents).mockRejectedValueOnce(new ApiError("Expired cursor", 409));
    const { result, client } = start();
    await waitFor(() => expect(result.current.historyGap).toBe(true));
    expect(result.current.stale).toBe(true);
    expect(result.current.data?.sequence).toBe(2);
    client.clear();
  });
});
