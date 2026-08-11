import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const authMocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isValid: vi.fn(),
  reportFailure: vi.fn(),
}));
const notificationMocks = vi.hoisted(() => ({
  settings: { desktop: false, sound: false },
  showTaskAssignment: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getAuthSession: authMocks.getAuthSession,
  },
  webSocketAuthenticationIsValid: authMocks.isValid,
  reportWebSocketAuthenticationFailure: authMocks.reportFailure,
}));

vi.mock("@/hooks/useNotificationSettings", () => ({
  useNotificationSettings: () => ({
    settings: notificationMocks.settings,
  }),
}));

vi.mock("@/lib/notifications", () => ({
  playStatusChangeBeep: vi.fn(),
  showTaskAssignmentNotification: notificationMocks.showTaskAssignment,
  showTaskMovedNotification: vi.fn(),
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send() {}

  addEventListener(type: string, listener: () => void) {
    if (type === "open") {
      this.onopen = listener;
    }
  }
}

const { useWebSocket } = await import("@/hooks/useWebSocket");

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useWebSocket authentication lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    authMocks.isValid.mockReturnValue(true);
    notificationMocks.settings.desktop = false;
    notificationMocks.settings.sound = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops reconnecting when the session check reports an authentication failure", async () => {
    authMocks.getAuthSession.mockResolvedValue({
      participantsModeEnabled: true,
      authenticated: false,
      participant: null,
      csrfToken: null,
      expiresAt: null,
    });
    renderHook(() => useWebSocket(), { wrapper });

    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      FakeWebSocket.instances[0]?.onclose?.();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(authMocks.reportFailure).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("resumes reconnecting after a valid session check", async () => {
    authMocks.getAuthSession.mockResolvedValue({
      participantsModeEnabled: true,
      authenticated: true,
      participant: {
        id: "participant-1",
        displayName: "Ada",
        role: "admin",
        active: true,
      },
      csrfToken: "csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    renderHook(() => useWebSocket(), { wrapper });

    await act(async () => {
      FakeWebSocket.instances[0]?.onclose?.();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(authMocks.reportFailure).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("refreshes ownership queries and notifies on task handoff", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(["task", "task-1"], {
      id: "task-1",
      title: "Owned task",
      status: "implementing",
    });
    notificationMocks.settings.desktop = true;
    renderHook(() => useWebSocket(), { wrapper: createWrapper(queryClient) });

    act(() => {
      FakeWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: "task:handoff",
          payload: {
            taskId: "task-1",
            projectId: "project-1",
            ownership: {
              executionOwner: "human",
              ownershipRevision: 2,
              assignees: [
                {
                  participantId: "participant-1",
                  displayName: "Ada",
                  role: "member",
                  active: true,
                },
              ],
            },
          },
        }),
      } as MessageEvent);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["task", "task-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["task-executor-history", "task-1"],
    });
    expect(notificationMocks.showTaskAssignment).toHaveBeenCalledWith(
      "task-1",
      "Owned task",
      "human",
      expect.arrayContaining([expect.objectContaining({ displayName: "Ada" })]),
    );
  });

  it("invalidates the current participant session when it is revoked", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(["auth", "session"], {
      participantsModeEnabled: true,
      authenticated: true,
      participant: { id: "participant-1", displayName: "Ada", role: "member", active: true },
      csrfToken: "csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    renderHook(() => useWebSocket(), { wrapper: createWrapper(queryClient) });

    act(() => {
      FakeWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: "auth:session_revoked",
          payload: { participantId: "participant-1" },
        }),
      } as MessageEvent);
    });

    expect(authMocks.reportFailure).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["auth", "session"] });
  });
});
