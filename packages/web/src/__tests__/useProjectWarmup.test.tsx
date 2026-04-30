import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

const mockGetProjectWarmup = vi.fn();
const mockCreateProjectWarmup = vi.fn();
const mockClearProjectWarmup = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getProjectWarmup: (...args: unknown[]) => mockGetProjectWarmup(...args),
    createProjectWarmup: (...args: unknown[]) => mockCreateProjectWarmup(...args),
    clearProjectWarmup: (...args: unknown[]) => mockClearProjectWarmup(...args),
  },
}));

const {
  useProjectWarmup,
  useCreateProjectWarmup,
  useClearProjectWarmup,
  projectWarmupQueryKey,
  invalidateProjectWarmupQueries,
} = await import("@/hooks/useProjectWarmup");

function createWrapper(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useProjectWarmup", () => {
  beforeEach(() => {
    mockGetProjectWarmup.mockReset();
    mockCreateProjectWarmup.mockReset();
    mockClearProjectWarmup.mockReset();
  });

  it("fetches project warmup support and active state", async () => {
    mockGetProjectWarmup.mockResolvedValue({
      enabled: true,
      support: { supported: true, runtimeId: "claude" },
      warmup: null,
    });

    const { result } = renderHook(() => useProjectWarmup("project-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGetProjectWarmup).toHaveBeenCalledWith("project-1");
    expect(result.current.data?.support.supported).toBe(true);
  });

  it("does not fetch without a project id", async () => {
    renderHook(() => useProjectWarmup(null), { wrapper: createWrapper() });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockGetProjectWarmup).not.toHaveBeenCalled();
  });

  it("invalidates warmup queries after create and clear mutations", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mockCreateProjectWarmup.mockResolvedValue({ enabled: true, support: {}, warmup: null });
    mockClearProjectWarmup.mockResolvedValue({ success: true, cleared: 1 });

    const { result: createResult } = renderHook(() => useCreateProjectWarmup("project-1"), {
      wrapper: createWrapper(queryClient),
    });
    const { result: clearResult } = renderHook(() => useClearProjectWarmup("project-1"), {
      wrapper: createWrapper(queryClient),
    });

    await createResult.current.mutateAsync({ ttlSeconds: 120 });
    await clearResult.current.mutateAsync();

    expect(mockCreateProjectWarmup).toHaveBeenCalledWith("project-1", { ttlSeconds: 120 });
    expect(mockClearProjectWarmup).toHaveBeenCalledWith("project-1");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectWarmupQueryKey("project-1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });

  it("can invalidate all project warmup support queries after runtime default changes", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateProjectWarmupQueries(queryClient);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projectWarmup"] });
  });
});
