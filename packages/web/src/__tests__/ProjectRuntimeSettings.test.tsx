import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Project, RuntimeProfile } from "@aif/shared/browser";

const mockUpdateProject = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockCreateRuntimeProfile = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockUpdateRuntimeProfile = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockDeleteRuntimeProfile = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockValidateRuntimeProfile = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockAppRuntimeDefaults = {
  data: {
    resolvedDefaultTaskRuntimeProfileId: "global-1",
    resolvedDefaultPlanRuntimeProfileId: "global-1",
    resolvedDefaultReviewRuntimeProfileId: "global-1",
    resolvedDefaultChatRuntimeProfileId: null,
  },
};

let mockProfiles: RuntimeProfile[] = [];
let mockProjectProfiles: RuntimeProfile[] = [];

vi.mock("@/hooks/useProjects", () => ({
  useUpdateProject: () => mockUpdateProject,
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useAppRuntimeDefaults: () => mockAppRuntimeDefaults,
  useCreateRuntimeProfile: () => mockCreateRuntimeProfile,
  useDeleteRuntimeProfile: () => mockDeleteRuntimeProfile,
  useProjectRuntimeProfiles: () => ({ data: mockProjectProfiles, isLoading: false }),
  useRuntimes: () => ({ data: [] }),
  useRuntimeModels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRuntimeProfiles: () => ({ data: mockProfiles, isLoading: false }),
  useUpdateRuntimeProfile: () => mockUpdateRuntimeProfile,
  useValidateRuntimeProfile: () => mockValidateRuntimeProfile,
}));

const { ProjectRuntimeSettings } = await import("@/components/project/ProjectRuntimeSettings");

const baseProjectProfile: RuntimeProfile = {
  id: "project-1",
  projectId: "project-a",
  name: "Project Local",
  runtimeId: "claude",
  providerId: "anthropic",
  transport: "sdk",
  baseUrl: null,
  apiKeyEnvVar: null,
  defaultModel: "sonnet",
  headers: {},
  options: {},
  enabled: true,
  runtimeLimitSnapshot: null,
  runtimeLimitUpdatedAt: null,
  lastUsage: null,
  lastUsageAt: null,
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
};

const baseGlobalProfile: RuntimeProfile = {
  id: "global-1",
  projectId: null,
  name: "Shared Codex",
  runtimeId: "codex",
  providerId: "openai",
  transport: "cli",
  baseUrl: null,
  apiKeyEnvVar: null,
  defaultModel: "gpt-5.4",
  headers: {},
  options: {},
  enabled: true,
  runtimeLimitSnapshot: null,
  runtimeLimitUpdatedAt: null,
  lastUsage: null,
  lastUsageAt: null,
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
};

const baseDisabledGlobalProfile: RuntimeProfile = {
  ...baseGlobalProfile,
  id: "global-disabled",
  name: "Disabled Global",
  enabled: false,
};

const project: Project = {
  id: "project-a",
  name: "Project A",
  rootPath: "C:/projects/project-a",
  plannerMaxBudgetUsd: null,
  planCheckerMaxBudgetUsd: null,
  implementerMaxBudgetUsd: null,
  reviewSidecarMaxBudgetUsd: null,
  parallelEnabled: false,
  autoQueueMode: false,
  defaultTaskRuntimeProfileId: "project-1",
  defaultPlanRuntimeProfileId: null,
  defaultReviewRuntimeProfileId: null,
  defaultChatRuntimeProfileId: null,
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
};

describe("ProjectRuntimeSettings", () => {
  beforeEach(() => {
    mockProfiles = [baseProjectProfile, baseGlobalProfile, baseDisabledGlobalProfile];
    mockProjectProfiles = [baseProjectProfile];
    mockUpdateProject.mutateAsync.mockReset();
    mockUpdateProject.mutateAsync.mockResolvedValue(project);
    mockCreateRuntimeProfile.mutateAsync.mockReset();
    mockUpdateRuntimeProfile.mutateAsync.mockReset();
    mockUpdateRuntimeProfile.mutateAsync.mockResolvedValue({
      ...baseProjectProfile,
      projectId: null,
    });
    mockDeleteRuntimeProfile.mutateAsync.mockReset();
    mockDeleteRuntimeProfile.mutateAsync.mockResolvedValue({ success: true });
    mockValidateRuntimeProfile.mutateAsync.mockReset();
  });

  it("renders structured runtime health for configured profiles", () => {
    const limitProfile: RuntimeProfile = {
      ...baseProjectProfile,
      name: "Claude Team",
      runtimeLimitSnapshot: {
        source: "api_headers",
        status: "blocked",
        precision: "exact",
        checkedAt: "2026-04-17T00:00:00.000Z",
        providerId: "anthropic",
        runtimeId: "claude",
        profileId: "project-1",
        primaryScope: "requests",
        resetAt: "2099-04-17T01:00:00.000Z",
        retryAfterSeconds: null,
        warningThreshold: 10,
        windows: [
          {
            scope: "requests",
            percentRemaining: 5,
            warningThreshold: 10,
          },
        ],
        providerMeta: null,
      },
      runtimeLimitUpdatedAt: "2026-04-17T00:00:00.000Z",
    };

    mockProfiles = [limitProfile];
    mockProjectProfiles = [limitProfile];

    render(<ProjectRuntimeSettings project={project} open hideTrigger />);

    expect(screen.getByText("Recent Limit Signals")).toBeDefined();
    expect(screen.getAllByText("Claude Team").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BLOCKED").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5% remaining/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Provider reset/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last checked/).length).toBeGreaterThan(0);
  });

  it("shows both project and global profiles in separate sections", async () => {
    render(
      <ProjectRuntimeSettings project={project} open={true} onOpenChange={vi.fn()} hideTrigger />,
    );

    expect(
      screen.getByText(
        "Project profiles are local to this project. Use Make Global to reuse one everywhere.",
      ),
    ).toBeDefined();
    expect(
      screen.getAllByText("Project Local [Project] (claude/anthropic)").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Global Profiles")).toBeDefined();
    expect(screen.getByText("Shared Codex [Global] (codex/openai)")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Project Local [Project] (claude/anthropic)",
      }),
    );
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Shared Codex [Global] (codex/openai)",
      })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Project Defaults" }));

    await waitFor(() => {
      expect(mockUpdateProject.mutateAsync).toHaveBeenCalledWith({
        id: "project-a",
        input: expect.objectContaining({
          defaultTaskRuntimeProfileId: "global-1",
        }),
      });
    });
  });

  it("promotes a project profile to global scope", async () => {
    render(
      <ProjectRuntimeSettings project={project} open={true} onOpenChange={vi.fn()} hideTrigger />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Make Global" }));

    await waitFor(() => {
      expect(mockUpdateRuntimeProfile.mutateAsync).toHaveBeenCalledWith({
        id: "project-1",
        input: { projectId: null },
      });
    });
  });

  it("keeps disabled profiles in management lists but removes them from default selectors", () => {
    render(
      <ProjectRuntimeSettings project={project} open={true} onOpenChange={vi.fn()} hideTrigger />,
    );

    expect(screen.getAllByText("Disabled Global [Global] (codex/openai)")).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Project Local [Project] (claude/anthropic)",
      }),
    );

    expect(screen.getAllByText("Disabled Global [Global] (codex/openai)")).toHaveLength(1);
    expect(screen.getAllByText("Shared Codex [Global] (codex/openai)").length).toBeGreaterThan(1);
  });

  it("deletes a global profile from the project screen after confirmation", async () => {
    render(
      <ProjectRuntimeSettings project={project} open={true} onOpenChange={vi.fn()} hideTrigger />,
    );

    const label = screen.getByText("Shared Codex [Global] (codex/openai)");
    const row = label.closest("div")?.parentElement;
    expect(row).toBeTruthy();

    fireEvent.click(within(row!).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() => {
      expect(mockDeleteRuntimeProfile.mutateAsync).toHaveBeenCalledWith("global-1");
    });
  });
});
