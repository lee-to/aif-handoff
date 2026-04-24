import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type MockAppRuntimeDefaults = {
  data: {
    defaultTaskRuntimeProfileId: string | null;
    defaultPlanRuntimeProfileId: string | null;
    defaultReviewRuntimeProfileId: string | null;
    defaultChatRuntimeProfileId: string | null;
    resolvedDefaultTaskRuntimeProfileId: string | null;
    resolvedDefaultPlanRuntimeProfileId: string | null;
    resolvedDefaultReviewRuntimeProfileId: string | null;
    resolvedDefaultChatRuntimeProfileId: string | null;
  };
};

const mockGlobalProfiles = {
  data: [
    {
      id: "global-1",
      projectId: null,
      name: "Shared Codex",
      runtimeId: "codex",
      providerId: "openai",
      transport: "cli",
      defaultModel: "gpt-5.4",
      enabled: true,
    },
    {
      id: "global-disabled",
      projectId: null,
      name: "Disabled Global",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      defaultModel: "sonnet",
      enabled: false,
    },
  ],
  isLoading: false,
};

const mockAppRuntimeDefaults: MockAppRuntimeDefaults = {
  data: {
    defaultTaskRuntimeProfileId: "global-disabled",
    defaultPlanRuntimeProfileId: "global-disabled",
    defaultReviewRuntimeProfileId: null,
    defaultChatRuntimeProfileId: "global-disabled",
    resolvedDefaultTaskRuntimeProfileId: null,
    resolvedDefaultPlanRuntimeProfileId: null,
    resolvedDefaultReviewRuntimeProfileId: null,
    resolvedDefaultChatRuntimeProfileId: null,
  },
};

const mockUpdateAppRuntimeDefaults = {
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

const mockApi = {
  getMcpStatus: vi.fn(),
  getConfigStatus: vi.fn(),
  getConfig: vi.fn(),
  installMcp: vi.fn(),
  removeMcp: vi.fn(),
};

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useGlobalRuntimeProfiles: () => mockGlobalProfiles,
  useRuntimes: () => ({ data: [] }),
  useRuntimeModels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAppRuntimeDefaults: () => mockAppRuntimeDefaults,
  useUpdateAppRuntimeDefaults: () => mockUpdateAppRuntimeDefaults,
  useCreateRuntimeProfile: () => mockCreateRuntimeProfile,
  useUpdateRuntimeProfile: () => mockUpdateRuntimeProfile,
  useDeleteRuntimeProfile: () => mockDeleteRuntimeProfile,
  useValidateRuntimeProfile: () => mockValidateRuntimeProfile,
}));

vi.mock("@/lib/api", () => ({
  api: mockApi,
}));

const { GlobalSettingsDialog } = await import("@/components/layout/GlobalSettingsDialog");

describe("GlobalSettingsDialog", () => {
  beforeEach(() => {
    mockGlobalProfiles.data = [
      {
        id: "global-1",
        projectId: null,
        name: "Shared Codex",
        runtimeId: "codex",
        providerId: "openai",
        transport: "cli",
        defaultModel: "gpt-5.4",
        enabled: true,
      },
      {
        id: "global-disabled",
        projectId: null,
        name: "Disabled Global",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        defaultModel: "sonnet",
        enabled: false,
      },
    ];
    mockAppRuntimeDefaults.data = {
      defaultTaskRuntimeProfileId: "global-disabled",
      defaultPlanRuntimeProfileId: "global-disabled",
      defaultReviewRuntimeProfileId: null,
      defaultChatRuntimeProfileId: "global-disabled",
      resolvedDefaultTaskRuntimeProfileId: null,
      resolvedDefaultPlanRuntimeProfileId: null,
      resolvedDefaultReviewRuntimeProfileId: null,
      resolvedDefaultChatRuntimeProfileId: null,
    };
    mockUpdateAppRuntimeDefaults.mutateAsync.mockReset();
    mockUpdateAppRuntimeDefaults.mutateAsync.mockResolvedValue(mockAppRuntimeDefaults.data);
    mockApi.getMcpStatus.mockReset();
    mockApi.getMcpStatus.mockResolvedValue({
      installed: false,
      runtimes: [],
    });
    mockApi.getConfigStatus.mockReset();
    mockApi.getConfigStatus.mockResolvedValue({ exists: false, path: "" });
    mockApi.getConfig.mockReset();
    mockCreateRuntimeProfile.mutateAsync.mockReset();
    mockUpdateRuntimeProfile.mutateAsync.mockReset();
    mockDeleteRuntimeProfile.mutateAsync.mockReset();
    mockValidateRuntimeProfile.mutateAsync.mockReset();
  });

  it("renders reusable global profiles and saves app runtime defaults", async () => {
    render(<GlobalSettingsDialog open={true} onOpenChange={vi.fn()} projectId={null} />);

    expect(screen.getByText("Global Runtime Profiles")).toBeDefined();
    expect(screen.getAllByText("Shared Codex [Global] (codex/openai)").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "One or more disabled app defaults are no longer selectable and will be cleared on save.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Save Runtime Defaults" }));

    await waitFor(() => {
      expect(mockUpdateAppRuntimeDefaults.mutateAsync).toHaveBeenCalledWith({
        defaultTaskRuntimeProfileId: null,
        defaultPlanRuntimeProfileId: null,
        defaultReviewRuntimeProfileId: null,
        defaultChatRuntimeProfileId: null,
      });
    });
  });

  it("keeps enabled global profiles available for app defaults", async () => {
    mockAppRuntimeDefaults.data = {
      defaultTaskRuntimeProfileId: "global-1",
      defaultPlanRuntimeProfileId: null,
      defaultReviewRuntimeProfileId: null,
      defaultChatRuntimeProfileId: null,
      resolvedDefaultTaskRuntimeProfileId: "global-1",
      resolvedDefaultPlanRuntimeProfileId: "global-1",
      resolvedDefaultReviewRuntimeProfileId: "global-1",
      resolvedDefaultChatRuntimeProfileId: null,
    };

    render(<GlobalSettingsDialog open={true} onOpenChange={vi.fn()} projectId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Save Runtime Defaults" }));

    await waitFor(() => {
      expect(mockUpdateAppRuntimeDefaults.mutateAsync).toHaveBeenCalledWith({
        defaultTaskRuntimeProfileId: "global-1",
        defaultPlanRuntimeProfileId: null,
        defaultReviewRuntimeProfileId: null,
        defaultChatRuntimeProfileId: null,
      });
    });
  });

  it("copies a global profile into the current project", async () => {
    render(<GlobalSettingsDialog open={true} onOpenChange={vi.fn()} projectId="project-a" />);

    fireEvent.click(screen.getAllByRole("button", { name: "Copy to Project" })[0]!);

    await waitFor(() => {
      expect(mockCreateRuntimeProfile.mutateAsync).toHaveBeenCalledWith({
        projectId: "project-a",
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
      });
    });
  });
});
