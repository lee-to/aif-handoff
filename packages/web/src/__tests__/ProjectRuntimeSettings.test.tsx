import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project } from "@aif/shared/browser";

const mockUpdateProject = { mutateAsync: vi.fn(), isPending: false };
const mockCreateRuntimeProfile = { mutateAsync: vi.fn(), isPending: false };
const mockUpdateRuntimeProfile = { mutateAsync: vi.fn(), isPending: false };
const mockDeleteRuntimeProfile = { mutateAsync: vi.fn(), isPending: false };
const mockValidateRuntimeProfile = { mutateAsync: vi.fn(), isPending: false };

let mockProfiles: Array<Record<string, unknown>> = [];

vi.mock("@/hooks/useProjects", () => ({
  useUpdateProject: () => mockUpdateProject,
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useCreateRuntimeProfile: () => mockCreateRuntimeProfile,
  useDeleteRuntimeProfile: () => mockDeleteRuntimeProfile,
  useRuntimes: () => ({ data: [] }),
  useRuntimeProfiles: () => ({ data: mockProfiles, isLoading: false }),
  useUpdateRuntimeProfile: () => mockUpdateRuntimeProfile,
  useValidateRuntimeProfile: () => mockValidateRuntimeProfile,
}));

const { ProjectRuntimeSettings } = await import("@/components/project/ProjectRuntimeSettings");

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

describe("ProjectRuntimeSettings", () => {
  beforeEach(() => {
    mockProfiles = [];
    mockUpdateProject.mutateAsync.mockReset();
    mockCreateRuntimeProfile.mutateAsync.mockReset();
    mockUpdateRuntimeProfile.mutateAsync.mockReset();
    mockDeleteRuntimeProfile.mutateAsync.mockReset();
    mockValidateRuntimeProfile.mutateAsync.mockReset();
  });

  it("renders structured runtime health for configured profiles", () => {
    mockProfiles = [
      {
        id: "profile-1",
        projectId: "project-1",
        name: "Claude Team",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        defaultModel: "claude-sonnet",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "api_headers",
          status: "blocked",
          precision: "exact",
          checkedAt: "2026-04-17T00:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-1",
          primaryScope: "requests",
          resetAt: "2099-04-17T01:00:00.000Z",
          warningThreshold: 10,
          windows: [{ scope: "requests", percentRemaining: 5, warningThreshold: 10 }],
          providerMeta: null,
        },
        runtimeLimitUpdatedAt: "2026-04-17T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    render(<ProjectRuntimeSettings project={project} open hideTrigger />);

    expect(screen.getByText("Recent Limit Signals")).toBeDefined();
    expect(screen.getAllByText("Claude Team").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BLOCKED").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Request quota crossed the 10% safety threshold (5% remaining).").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Provider reset/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last checked/).length).toBeGreaterThan(0);
  });
});
