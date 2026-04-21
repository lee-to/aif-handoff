import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub network-dependent hooks so the component tree renders without real API calls.

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: vi.fn(),
}));

function stubHookModule(keys: string[]) {
  const stub = () => ({
    data: undefined,
    isLoading: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  return Object.fromEntries(keys.map((key) => [key, vi.fn(stub)]));
}

vi.mock("@/hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return stubHookModule(Object.keys(actual));
});

vi.mock("@/hooks/useTasks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return stubHookModule(Object.keys(actual));
});

vi.mock("@/hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return stubHookModule(Object.keys(actual));
});

vi.mock("@/hooks/useRuntimeProfiles", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return stubHookModule(Object.keys(actual));
});

vi.mock("@/lib/api", () => ({
  api: new Proxy(
    {},
    {
      get: () => vi.fn().mockResolvedValue([]),
    },
  ),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
    useMutation: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
  };
});

const App = (await import("../App")).default;

describe("App smoke test", () => {
  it("renders without crashing (providers are wired correctly)", () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it("shows the empty-state message when no project is selected", () => {
    render(<App />);
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});
