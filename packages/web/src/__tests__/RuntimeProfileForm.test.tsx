import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeDescriptor } from "@aif/shared/browser";

const mockRuntimeModels = {
  isPending: false,
  mutateAsync: vi.fn(),
};

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useRuntimeModels: () => mockRuntimeModels,
}));

const { RuntimeProfileForm } = await import("@/components/settings/RuntimeProfileForm");

function createRuntimeDescriptor(overrides: Partial<RuntimeDescriptor>): RuntimeDescriptor {
  return {
    id: "runtime",
    providerId: "provider",
    displayName: "Runtime",
    defaultTransport: "sdk",
    defaultApiKeyEnvVar: "API_KEY",
    defaultModelPlaceholder: "model-id",
    supportedTransports: ["sdk"],
    capabilities: {
      supportsResume: true,
      supportsSessionList: false,
      supportsAgentDefinitions: false,
      supportsStreaming: true,
      supportsModelDiscovery: true,
      supportsApprovals: false,
      supportsCustomEndpoint: true,
    },
    ...overrides,
  };
}

function createDeferredResult() {
  let resolve!: (value: { models: unknown[]; profile: Record<string, unknown> }) => void;
  const promise = new Promise<{ models: unknown[]; profile: Record<string, unknown> }>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe("RuntimeProfileForm", () => {
  beforeEach(() => {
    mockRuntimeModels.isPending = false;
    mockRuntimeModels.mutateAsync.mockReset();
    mockRuntimeModels.mutateAsync.mockResolvedValue({
      models: [],
      profile: {},
    });
  });

  it("uses runtime default transport, keeps manual model input, and stores codex effort separately", async () => {
    mockRuntimeModels.mutateAsync.mockResolvedValue({
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          metadata: {
            supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
          },
        },
      ],
      profile: {},
    });
    const onSubmit = vi.fn();

    render(
      <RuntimeProfileForm
        mode="create"
        projectId="project-1"
        runtimes={[
          createRuntimeDescriptor({
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            defaultTransport: "cli",
            defaultApiKeyEnvVar: "OPENAI_API_KEY",
            defaultModelPlaceholder: "gpt-5.4",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("Leave empty to auto-fill from selected runtime")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockRuntimeModels.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          profile: expect.objectContaining({
            runtimeId: "codex",
            transport: "cli",
          }),
          forceRefresh: false,
        }),
      );
    });

    fireEvent.change(screen.getByDisplayValue("gpt-5.4"), {
      target: { value: "gpt-5.4-custom" },
    });

    fireEvent.click(screen.getByRole("button", { name: /runtime default/i }));
    fireEvent.click(screen.getByRole("button", { name: "XHIGH" }));
    fireEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Codex",
        runtimeId: "codex",
        providerId: "openai",
        transport: "cli",
        defaultModel: "gpt-5.4-custom",
        options: {
          modelReasoningEffort: "xhigh",
        },
      }),
    );
  });

  it("derives Claude effort choices from the selected model", async () => {
    mockRuntimeModels.mutateAsync.mockResolvedValue({
      models: [
        {
          id: "sonnet",
          label: "Claude Sonnet",
          metadata: {
            supportedEffortLevels: ["low", "medium", "high"],
          },
        },
      ],
      profile: {},
    });
    const onSubmit = vi.fn();

    render(
      <RuntimeProfileForm
        mode="create"
        projectId={null}
        runtimes={[
          createRuntimeDescriptor({
            id: "claude",
            providerId: "anthropic",
            displayName: "Claude",
            defaultTransport: "sdk",
            defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
            defaultModelPlaceholder: "sonnet",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() => expect(screen.getByDisplayValue("sonnet")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /runtime default/i }));
    expect(screen.getByRole("button", { name: "HIGH" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MAX" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "HIGH" }));
    fireEvent.click(screen.getByRole("button", { name: /create profile/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Claude",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        defaultModel: "sonnet",
        options: {
          effort: "high",
        },
      }),
    );
  });

  it("resets stale model state when switching runtimes and auto-selects the new runtime default", async () => {
    const codexLoad = createDeferredResult();
    const claudeLoad = createDeferredResult();

    mockRuntimeModels.mutateAsync.mockImplementation(({ profile }) => {
      if (profile.runtimeId === "codex") {
        return codexLoad.promise;
      }

      return claudeLoad.promise;
    });

    render(
      <RuntimeProfileForm
        mode="create"
        projectId="project-1"
        runtimes={[
          createRuntimeDescriptor({
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            defaultTransport: "sdk",
            defaultApiKeyEnvVar: "OPENAI_API_KEY",
            defaultModelPlaceholder: "gpt-5.4",
            supportedTransports: ["sdk", "cli", "api"],
          }),
          createRuntimeDescriptor({
            id: "claude",
            providerId: "anthropic",
            displayName: "Claude",
            defaultTransport: "sdk",
            defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
            defaultModelPlaceholder: "sonnet",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockRuntimeModels.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          profile: expect.objectContaining({
            runtimeId: "codex",
          }),
          forceRefresh: false,
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /codex \(codex\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /claude \(claude\)/i }));

    await waitFor(() => {
      expect(mockRuntimeModels.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          profile: expect.objectContaining({
            runtimeId: "claude",
          }),
          forceRefresh: false,
        }),
      );
    });

    claudeLoad.resolve({
      models: [
        {
          id: "GLM-5-Turbo",
          label: "GLM-5 Turbo",
          metadata: {
            isDefault: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        },
        {
          id: "GLM-5-Air",
          label: "GLM-5 Air",
          metadata: {
            supportedEffortLevels: ["low", "medium"],
          },
        },
      ],
      profile: {},
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("GLM-5-Turbo")).toBeInTheDocument();
    });

    codexLoad.resolve({
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          metadata: {
            isDefault: true,
            supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
          },
        },
      ],
      profile: {},
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("GLM-5-Turbo")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("gpt-5.4")).toBeNull();
  });

  it("preserves a manual model override when delayed discovery finishes", async () => {
    const delayedLoad = createDeferredResult();
    mockRuntimeModels.mutateAsync.mockImplementation(() => delayedLoad.promise);

    render(
      <RuntimeProfileForm
        mode="create"
        projectId="project-1"
        runtimes={[
          createRuntimeDescriptor({
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            defaultTransport: "cli",
            defaultApiKeyEnvVar: "OPENAI_API_KEY",
            defaultModelPlaceholder: "gpt-5.4",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockRuntimeModels.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          profile: expect.objectContaining({
            runtimeId: "codex",
            transport: "cli",
          }),
          forceRefresh: false,
        }),
      );
    });

    fireEvent.change(screen.getByPlaceholderText("gpt-5.4"), {
      target: { value: "gpt-5.4-custom" },
    });

    delayedLoad.resolve({
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          metadata: {
            isDefault: true,
            supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
          },
        },
      ],
      profile: {},
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("gpt-5.4-custom")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("gpt-5.4")).toBeNull();
  });

  it("shows model filter for large catalogs and filters case-insensitively", async () => {
    mockRuntimeModels.mutateAsync.mockResolvedValue({
      models: [
        { id: "alpha-1", label: "Alpha 1" },
        { id: "gemma-2b-it", label: "Gemma 2B IT" },
        { id: "GeMmA-9b", label: "GeMmA 9B" },
        { id: "llama-3", label: "Llama 3" },
        { id: "mistral-small", label: "Mistral Small" },
        { id: "qwen-2.5", label: "Qwen 2.5" },
      ],
      profile: {},
    });

    render(
      <RuntimeProfileForm
        mode="create"
        projectId="project-1"
        runtimes={[
          createRuntimeDescriptor({
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            defaultTransport: "cli",
            defaultApiKeyEnvVar: "OPENAI_API_KEY",
            defaultModelPlaceholder: "gpt-5.4",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={vi.fn()}
      />,
    );

    const selectButton = await screen.findByRole("button", { name: /Alpha 1 \(alpha-1\)/i });
    fireEvent.click(selectButton);
    const filterInput = await screen.findByPlaceholderText("Filter suggested models");
    await waitFor(() => expect(filterInput).toHaveFocus());
    fireEvent.change(filterInput, { target: { value: "gEmMa" } });

    expect(
      screen.getByRole("button", { name: /Gemma 2B IT \(gemma-2b-it\)/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GeMmA 9B \(GeMmA-9b\)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Llama 3/i })).toBeNull();
  });

  it("does not show model filter when suggested models are five or fewer", async () => {
    mockRuntimeModels.mutateAsync.mockResolvedValue({
      models: [
        { id: "alpha-1", label: "Alpha 1" },
        { id: "beta-1", label: "Beta 1" },
        { id: "gamma-1", label: "Gamma 1" },
        { id: "delta-1", label: "Delta 1" },
        { id: "epsilon-1", label: "Epsilon 1" },
      ],
      profile: {},
    });

    render(
      <RuntimeProfileForm
        mode="create"
        projectId="project-1"
        runtimes={[
          createRuntimeDescriptor({
            id: "codex",
            providerId: "openai",
            displayName: "Codex",
            defaultTransport: "cli",
            defaultApiKeyEnvVar: "OPENAI_API_KEY",
            defaultModelPlaceholder: "gpt-5.4",
            supportedTransports: ["sdk", "cli", "api"],
          }),
        ]}
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("alpha-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Alpha 1 \(alpha-1\)/i }));
    expect(screen.queryByPlaceholderText("Filter suggested models")).toBeNull();
  });
});
