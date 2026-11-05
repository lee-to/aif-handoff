import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    getThreadWorkspace: mocks.get,
    createThreadObjective: mocks.create,
    updateThreadObjective: mocks.update,
    linkTaskToThread: mocks.link,
    unlinkTaskFromThread: mocks.unlink,
    updateChatSession: mocks.status,
  },
}));
const { useThreadWorkspace } = await import("@/hooks/useThreadWorkspace");

function setup(threadId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return {
    client,
    ...renderHook(({ id }) => useThreadWorkspace(id), { initialProps: { id: threadId }, wrapper }),
  };
}

describe("useThreadWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.get.mockImplementation(async (id: string) => ({
      thread: { id },
      objectives: [],
      tasks: [],
    }));
  });

  it("does not load a workspace for a virtual or unselected chat", () => {
    setup(null);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("saves objectives and refreshes workspace and session lists", async () => {
    mocks.create.mockResolvedValue({ id: "objective" });
    const { result, client } = setup("thread-1");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.createObjective({ title: "Deliver" });
    });
    expect(mocks.create).toHaveBeenCalledWith("thread-1", { title: "Deliver" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["threadWorkspace", "thread-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chatSessions"] });
  });

  it("keeps mutation errors scoped to the active thread", async () => {
    mocks.update.mockRejectedValue(new Error("Cannot reopen a completed objective"));
    const { result, rerender } = setup("thread-1");
    await act(async () => {
      await result.current
        .updateObjective({ objectiveId: "objective", status: "open" })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).toBe("Cannot reopen a completed objective"));
    rerender({ id: "thread-2" });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
