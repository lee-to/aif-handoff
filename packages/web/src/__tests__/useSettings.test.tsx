import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

// Mock api module
const mockGetSettings = vi.fn();
const mockGetProjectDefaults = vi.fn();

vi.mock("../lib/api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    getProjectDefaults: (...args: unknown[]) => mockGetProjectDefaults(...args),
  },
}));

import { useSettings, useProjectDefaults } from "../hooks/useSettings.js";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useSettings", () => {
  beforeEach(() => {
    mockGetSettings.mockReset();
    mockGetProjectDefaults.mockReset();
  });

  it("fetches settings via React Query (single request, no duplication)", async () => {
    mockGetSettings.mockResolvedValue({ useSubagents: true, maxReviewIterations: 3 });

    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ useSubagents: true, maxReviewIterations: 3 });
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
  });
});

describe("useProjectDefaults", () => {
  it("fetches project defaults when projectId is provided", async () => {
    mockGetProjectDefaults.mockResolvedValue({
      paths: { plan: "custom/PLAN.md", plans: "custom/plans/" },
      workflow: {},
    });

    const { result } = renderHook(() => useProjectDefaults("project-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.paths.plan).toBe("custom/PLAN.md");
    expect(mockGetProjectDefaults).toHaveBeenCalledWith("project-1");
    expect(mockGetProjectDefaults).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when projectId is null", async () => {
    mockGetProjectDefaults.mockReset();

    const { result } = renderHook(() => useProjectDefaults(null), {
      wrapper: createWrapper(),
    });

    // Give it a tick to ensure no fetch is triggered
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.isFetching).toBe(false);
    expect(mockGetProjectDefaults).not.toHaveBeenCalled();
  });
});
