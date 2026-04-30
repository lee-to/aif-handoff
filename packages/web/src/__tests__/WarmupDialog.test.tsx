import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import type { Project } from "@aif/shared/browser";

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

const { WarmupDialog } = await import("@/components/project/WarmupDialog");

const project: Project = {
  id: "project-1",
  name: "Project One",
  rootPath: "/tmp/project-1",
  plannerMaxBudgetUsd: null,
  planCheckerMaxBudgetUsd: null,
  implementerMaxBudgetUsd: null,
  reviewSidecarMaxBudgetUsd: null,
  parallelEnabled: false,
  autoQueueMode: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeWarmupResponse(warmup: unknown = null) {
  return {
    enabled: true,
    support: {
      supported: true,
      skipReason: null,
      runtimeId: "claude",
      providerId: "anthropic",
      runtimeProfileId: "profile-1",
      transport: "sdk",
      model: "claude-sonnet",
      selectionSource: "project_default",
    },
    warmup,
  };
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WarmupDialog open onOpenChange={vi.fn()} project={project} enabled />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("WarmupDialog", () => {
  beforeEach(() => {
    mockGetProjectWarmup.mockReset();
    mockCreateProjectWarmup.mockReset();
    mockClearProjectWarmup.mockReset();
  });

  it("renders runtime metadata and remaining lifetime", async () => {
    mockGetProjectWarmup.mockResolvedValue(
      makeWarmupResponse({
        id: "warmup-1",
        projectId: "project-1",
        runtimeProfileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: "claude-sonnet",
        status: "ready",
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3665 * 1000).toISOString(),
        remainingSeconds: 3665,
        summary: "Seed context ready",
        errorMessage: null,
        createdAt: "2026-04-30T11:00:00.000Z",
        updatedAt: "2026-04-30T11:00:10.000Z",
      }),
    );

    renderDialog();

    expect(await screen.findByText("READY")).toBeDefined();
    expect(screen.getByText("claude/anthropic sdk")).toBeDefined();
    expect(screen.getByText("claude-sonnet")).toBeDefined();
    expect(screen.getByText("Seed context ready")).toBeDefined();
    expect(screen.getByText(/1h 1m/)).toBeDefined();
  });

  it("validates TTL bounds before create", async () => {
    mockGetProjectWarmup.mockResolvedValue(makeWarmupResponse());

    renderDialog();

    await screen.findByRole("button", { name: /Create/ });
    fireEvent.change(screen.getByLabelText("TTL seconds"), { target: { value: "30" } });

    expect(screen.getByText("Enter 60-86400.")).toBeDefined();
    expect(screen.getByRole("button", { name: /Create/ })).toBeDisabled();
  });

  it("creates and clears warmup sessions", async () => {
    mockGetProjectWarmup.mockResolvedValue(makeWarmupResponse());
    mockCreateProjectWarmup.mockResolvedValue(makeWarmupResponse());
    mockClearProjectWarmup.mockResolvedValue({ success: true, cleared: 1 });

    renderDialog();

    await screen.findByRole("button", { name: /Create/ });
    fireEvent.change(screen.getByLabelText("TTL seconds"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));

    await waitFor(() =>
      expect(mockCreateProjectWarmup).toHaveBeenCalledWith("project-1", { ttlSeconds: 120 }),
    );
  });

  it("clears an active warmup session", async () => {
    mockGetProjectWarmup.mockResolvedValue(
      makeWarmupResponse({
        id: "warmup-1",
        projectId: "project-1",
        runtimeProfileId: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        model: "claude-sonnet",
        status: "ready",
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        remainingSeconds: 3600,
        summary: null,
        errorMessage: null,
        createdAt: "2026-04-30T11:00:00.000Z",
        updatedAt: "2026-04-30T11:00:10.000Z",
      }),
    );
    mockClearProjectWarmup.mockResolvedValue({ success: true, cleared: 1 });

    renderDialog();

    await screen.findByText("READY");
    const clearButton = screen.getByRole("button", { name: /Clear/ });
    expect(clearButton).toBeEnabled();
    fireEvent.click(clearButton);

    await waitFor(() => expect(mockClearProjectWarmup).toHaveBeenCalledWith("project-1"));
  });
});
