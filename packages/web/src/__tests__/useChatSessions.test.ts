import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const mockListChatSessions = vi.fn();
const mockCreateChatSession = vi.fn();
const mockDeleteChatSession = vi.fn();
const mockUpdateChatSession = vi.fn();
const mockGetChatSessionMessages = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    listChatSessions: (...args: unknown[]) => mockListChatSessions(...args),
    createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
    deleteChatSession: (...args: unknown[]) => mockDeleteChatSession(...args),
    updateChatSession: (...args: unknown[]) => mockUpdateChatSession(...args),
    getChatSessionMessages: (...args: unknown[]) => mockGetChatSessionMessages(...args),
  },
}));

const { useChatSessions } = await import("@/hooks/useChatSessions");

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useChatSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChatSessions.mockResolvedValue([]);
  });

  it("returns empty sessions initially", () => {
    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
  });

  it("lists sessions for project", async () => {
    mockListChatSessions.mockResolvedValue([
      { id: "s1", projectId: "proj-1", title: "Chat 1", updatedAt: "2026-01-01" },
    ]);

    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });
    expect(result.current.sessions[0].id).toBe("s1");
  });

  it("creates session and sets as active", async () => {
    mockCreateChatSession.mockResolvedValue({
      id: "s-new",
      projectId: "proj-1",
      title: "New",
    });

    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.createSession("New");
    });

    expect(mockCreateChatSession).toHaveBeenCalledWith({
      projectId: "proj-1",
      title: "New",
    });
    expect(result.current.activeSessionId).toBe("s-new");
  });

  it("claims a discovered runtime session and selects the persisted thread", async () => {
    mockCreateChatSession.mockResolvedValue({
      id: "s-claimed",
      projectId: "proj-1",
      title: "Existing Codex chat".repeat(20),
      source: "web",
    });
    const discovered = {
      id: "runtime:codex:runtime-1",
      projectId: "proj-1",
      title: "Existing Codex chat".repeat(20),
      source: "cli" as const,
      runtimeProfileId: "profile-1",
      runtimeSessionId: "runtime-1",
      status: "open" as const,
      agentSessionId: null,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    };

    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.claimSession(discovered);
    });

    expect(mockCreateChatSession).toHaveBeenCalledWith({
      projectId: "proj-1",
      title: "Existing Codex chat".repeat(20).slice(0, 200),
      runtimeProfileId: "profile-1",
      runtimeSessionId: "runtime-1",
    });
    expect(result.current.activeSessionId).toBe("s-claimed");
  });

  it("deletes session and switches to next", async () => {
    mockListChatSessions.mockResolvedValue([
      { id: "s1", projectId: "proj-1", title: "Chat 1", updatedAt: "2026-01-01" },
      { id: "s2", projectId: "proj-1", title: "Chat 2", updatedAt: "2026-01-02" },
    ]);
    mockDeleteChatSession.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    act(() => {
      result.current.setActiveSessionId("s1");
    });

    await act(async () => {
      await result.current.deleteSession("s1");
    });

    expect(mockDeleteChatSession).toHaveBeenCalledWith("s1");
    // Should switch to s2
    expect(result.current.activeSessionId).toBe("s2");
  });

  it("renames session", async () => {
    mockUpdateChatSession.mockResolvedValue({
      id: "s1",
      projectId: "proj-1",
      title: "Renamed",
    });

    const { result } = renderHook(() => useChatSessions("proj-1"), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.renameSession("s1", "Renamed");
    });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("s1", { title: "Renamed" });
  });

  it("does not fetch when projectId is null", () => {
    const { result } = renderHook(() => useChatSessions(null), {
      wrapper: createWrapper(),
    });

    expect(mockListChatSessions).not.toHaveBeenCalled();
    expect(result.current.sessions).toEqual([]);
  });

  it("clears the active session when the current project changes", async () => {
    mockListChatSessions.mockImplementation((projectId: string) =>
      Promise.resolve(
        projectId === "proj-1"
          ? [{ id: "s1", projectId: "proj-1", title: "Chat 1", updatedAt: "2026-01-01" }]
          : [{ id: "s2", projectId: "proj-2", title: "Chat 2", updatedAt: "2026-01-02" }],
      ),
    );

    const { result, rerender } = renderHook(({ projectId }) => useChatSessions(projectId), {
      initialProps: { projectId: "proj-1" as string | null },
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("s1");
    });

    act(() => {
      result.current.setActiveSessionId("s1");
    });
    expect(result.current.activeSessionId).toBe("s1");

    rerender({ projectId: "proj-2" });

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("s2");
    });
    expect(result.current.activeSessionId).toBe("s2");
  });
});
