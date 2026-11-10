import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmConnection, SwarmSnapshot } from "@aif/shared/browser";
import { api } from "../lib/api";
import { SwarmPanel } from "../components/swarm/SwarmPanel";
import { SwarmRunDetail } from "../components/swarm/SwarmRunDetail";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), runs: vi.fn(), run: vi.fn() }));
vi.mock("@/hooks/useSwarm", () => ({
  useSwarmConnection: mocks.connection,
  useSwarmRuns: mocks.runs,
  useSwarmRun: mocks.run,
}));
const golden: SwarmSnapshot = JSON.parse(
  readFileSync(resolve("../../docs/swarm-v1.snapshot.json"), "utf8"),
);
let snapshot: SwarmSnapshot;
let connection: SwarmConnection;
const queryClient = () =>
  new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
function show(component = <SwarmPanel projectId="project-1" />) {
  return render(<QueryClientProvider client={queryClient()}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  snapshot = structuredClone(golden);
  connection = { enabled: true, projectId: "project-1", role: "owner", schemaVersion: 1 };
  mocks.connection.mockImplementation(() => ({
    data: connection,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }));
  mocks.runs.mockImplementation(() => ({
    data: { schema_version: 1, runs: [snapshot.run] },
    isPending: false,
    isError: false,
    dataUpdatedAt: Date.now(),
  }));
  mocks.run.mockImplementation(() => ({
    data: snapshot,
    events: [
      {
        schema_version: 1,
        event_id: "event-1",
        sequence: 1,
        run_id: "run-1",
        type: "approval.requested",
        timestamp: "2026-11-10T09:01:00Z",
        actor: { id: null, role: "lead" },
        task_id: "task-1",
        agent_id: "worker-1",
        payload: { note: "[REDACTED]" },
      },
    ],
    stale: false,
    historyGap: false,
    lastSyncedAt: Date.now(),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Swarm runs UI", () => {
  it("shows connection loading, failure and unconfigured projects", () => {
    mocks.connection.mockReturnValueOnce({ isPending: true });
    const view = show();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Swarm");
    view.unmount();
    mocks.connection.mockReturnValueOnce({ isError: true });
    const failed = show();
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    failed.unmount();
    connection.projectId = "other";
    show();
    expect(screen.getByText(/not connected to this project/)).toBeInTheDocument();
  });
  it("shows metrics, opens run details and respects viewer permissions", () => {
    connection.role = "viewer";
    show();
    expect(screen.queryByRole("button", { name: "New Swarm run" })).not.toBeInTheDocument();
    expect(screen.getByText(/Cost unknown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Documentation cleanup" }));
    expect(screen.getByText("Global acceptance criteria")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to runs" }));
    fireEvent.change(screen.getByLabelText("Search Swarm runs"), { target: { value: "missing" } });
    expect(screen.getByText("No matching Swarm runs.")).toBeInTheDocument();
  });
  it("marks cached lists stale when Runtime is unavailable", () => {
    mocks.runs.mockReturnValue({
      data: { runs: [snapshot.run] },
      isError: true,
      dataUpdatedAt: Date.now(),
    });
    show();
    expect(screen.getByRole("alert")).toHaveTextContent("stale");
    expect(screen.getByRole("button", { name: "New Swarm run" })).toBeDisabled();
  });
  it("validates a new run and preserves its idempotency key after an uncertain failure", async () => {
    const create = vi
      .spyOn(api, "createSwarmRun")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ run_id: "run-1" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "New Swarm run" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Clean links" } });
    fireEvent.change(screen.getByLabelText(/Acceptance criteria/), {
      target: { value: "Links pass\nTests pass" },
    });
    fireEvent.change(screen.getByLabelText("Worker limit"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Budget USD/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await screen.findByRole("button", { name: "Retry creation" });
    expect(screen.getByLabelText("Goal")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry creation" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    expect(create.mock.calls[0][0]).toMatchObject({
      worker_limit: 2,
      budget_usd: 5,
      acceptance_criteria: ["Links pass", "Tests pass"],
    });
    await screen.findByText("Global acceptance criteria");
  });
});

describe("Swarm run details", () => {
  it("requires confirmation before controlling Runtime and retries the same command", async () => {
    const control = vi
      .spyOn(api, "controlSwarmRun")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({});
    show(<SwarmRunDetail runId="run-1" role="operator" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Pause" }));
    await screen.findByRole("button", { name: "Retry command" });
    fireEvent.click(screen.getByRole("button", { name: "Retry command" }));
    await waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    expect(control.mock.calls[0]).toEqual(control.mock.calls[1]);
  });
  it("shows stale snapshots and history loss while disabling controls", () => {
    mocks.run.mockReturnValue({
      data: snapshot,
      events: [],
      stale: true,
      historyGap: true,
      lastSyncedAt: 100,
    });
    show(<SwarmRunDetail runId="run-1" role="owner" onBack={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Stale state");
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByText(/Older events are unavailable/)).toBeInTheDocument();
  });
  it("handles an unavailable initial snapshot", () => {
    mocks.run.mockReturnValue({ isError: true });
    show(<SwarmRunDetail runId="run-1" role="owner" onBack={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
  });
  it("shows tasks, agent history and redacted logs, diffs, CI and approval evidence", async () => {
    show(<SwarmRunDetail runId="run-1" role="owner" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(screen.getByText("Updated links")).toBeInTheDocument();
    expect(screen.getByText("links: passed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Submitted task-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Integration & review" }));
    fireEvent.click(screen.getByRole("button", { name: "Open diff" }));
    expect(screen.getByText(/old link/)).toBeInTheDocument();
    expect(screen.getByText(/CI: passed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText("approval.requested")).toBeInTheDocument();
    expect(screen.getByText(/REDACTED/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter events"), { target: { value: "missing" } });
    expect(screen.queryByText("approval.requested")).not.toBeInTheDocument();
  });
  it("collects a reason before an owner approves integration", async () => {
    const decision = vi.spyOn(api, "decideSwarmApproval").mockResolvedValue({});
    show(<SwarmRunDetail runId="run-1" role="owner" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Integration & review" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("button", { name: "Confirm Approve" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Tests passed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Approve" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        "run-1",
        "approval-1",
        expect.objectContaining({ decision: "approve", reason: "Tests passed" }),
      ),
    );
  });
  it("sends audited Lead instructions and hides approvals for operators", async () => {
    const instruct = vi.spyOn(api, "instructSwarmLead").mockResolvedValue({});
    show(<SwarmRunDetail runId="run-1" role="operator" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Instruct Lead" }));
    fireEvent.change(screen.getByLabelText("Lead instruction"), {
      target: { value: "Prioritize links" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Send instruction to Lead" }));
    await waitFor(() =>
      expect(instruct).toHaveBeenCalledWith("run-1", expect.any(String), "Prioritize links"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Integration & review" }));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
  it("keeps hierarchy separate from the dependency graph and selects task evidence", () => {
    snapshot.tasks.push({
      ...snapshot.tasks[0],
      id: "task-2",
      parent_id: "task-1",
      depends_on: ["task-1"],
      title: "Verify links",
    });
    show(<SwarmRunDetail runId="run-1" role="viewer" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Task graph" }));
    expect(screen.getByRole("group", { name: "Task dependency graph" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "task-2: Verify links" }), {
      key: "Enter",
    });
    expect(screen.getByText("task-2: Verify links")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Parent–child" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle children of task-1" }));
    expect(screen.queryByRole("button", { name: "Verify links" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search graph tasks"), { target: { value: "Verify" } });
    expect(screen.getByRole("button", { name: "Verify links" })).toBeInTheDocument();
  });
});
