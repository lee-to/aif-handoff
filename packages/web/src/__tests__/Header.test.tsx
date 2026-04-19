import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Project, RuntimeProfile } from "@aif/shared/browser";
import type { TaskMetricsSummary } from "@/lib/taskMetrics";

let mockTheme = "dark";
const mockToggleTheme = vi.fn();
let mockEffectiveChatRuntime: {
  profile: {
    id: string;
    name: string;
    runtimeId: string;
    providerId: string;
    defaultModel: string | null;
  } | null;
  resolved?: {
    runtimeId: string;
    providerId: string;
    model: string | null;
  };
} | null = null;
let mockRuntimeProfiles: RuntimeProfile[] = [];

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: mockTheme,
    toggleTheme: mockToggleTheme,
  }),
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useEffectiveChatRuntime: () => ({
    data: mockEffectiveChatRuntime,
    isFetching: false,
  }),
  useRuntimeProfiles: () => ({
    data: mockRuntimeProfiles,
    isLoading: false,
  }),
}));

vi.mock("@/components/project/ProjectSelector", () => ({
  ProjectSelector: () => <div>Project selector</div>,
}));

vi.mock("@/components/layout/NotificationsDialog", () => ({
  NotificationsDialog: () => null,
}));

vi.mock("@/components/layout/MetricsDialog", () => ({
  MetricsDialog: () => null,
}));

vi.mock("@/components/layout/RoadmapDialog", () => ({
  RoadmapDialog: () => null,
}));

vi.mock("@/components/layout/GlobalSettingsDialog", () => ({
  GlobalSettingsDialog: () => null,
}));

const { Header } = await import("@/components/layout/Header");

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

const metrics: TaskMetricsSummary = {
  totalTasks: 0,
  completedTasks: 0,
  verifiedTasks: 0,
  backlogTasks: 0,
  activeTasks: 0,
  blockedTasks: 0,
  autoModeTasks: 0,
  fixTasks: 0,
  totalRetries: 0,
  totalTokenInput: 0,
  totalTokenOutput: 0,
  totalTokenTotal: 0,
  averageTokensPerTask: 0,
  totalCostUsd: 0,
  averageCostPerTaskUsd: 0,
  completionRate: 0,
};

function renderHeader() {
  return render(
    <Header
      selectedProject={project}
      onSelectProject={vi.fn()}
      onDeselectProject={vi.fn()}
      onOpenCommandPalette={vi.fn()}
      density="comfortable"
      onDensityChange={vi.fn()}
      viewMode="kanban"
      onViewModeChange={vi.fn()}
      taskMetrics={metrics}
      aggregateTotals={null}
      runtimeProfilesOpen={false}
      onToggleRuntimeProfiles={vi.fn()}
    />,
  );
}

describe("Header", () => {
  beforeEach(() => {
    mockTheme = "dark";
    mockToggleTheme.mockClear();
    mockEffectiveChatRuntime = {
      profile: {
        id: "profile-chat",
        name: "Claude Team",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "claude-sonnet",
      },
      resolved: {
        runtimeId: "claude",
        providerId: "anthropic",
        model: "claude-sonnet",
      },
    };
    mockRuntimeProfiles = [];
  });

  it("opens runtime usage dialog and shows per-window quota entries for configured runtimes", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-claude",
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
          source: "sdk_event",
          status: "warning",
          precision: "heuristic",
          checkedAt: "2026-04-17T10:00:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-claude",
          primaryScope: "time",
          resetAt: "2099-04-17T05:00:00.000Z",
          warningThreshold: null,
          windows: [
            {
              scope: "time",
              name: "five_hour",
              percentRemaining: 90,
              resetAt: "2099-04-17T05:00:00.000Z",
            },
            {
              scope: "time",
              name: "seven_day",
              percentRemaining: 62,
              resetAt: "2099-04-24T05:00:00.000Z",
            },
          ],
          providerMeta: null,
        },
        runtimeLimitUpdatedAt: "2026-04-17T10:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "profile-codex",
        projectId: "project-1",
        name: "Codex API",
        runtimeId: "codex",
        providerId: "openai",
        transport: "api",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.4",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "api_headers",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-17T11:00:00.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex",
          primaryScope: "requests",
          resetAt: "2099-04-17T01:00:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "requests",
              remaining: 120,
              limit: 1000,
              percentRemaining: 12,
              resetAt: "2099-04-17T01:00:00.000Z",
              warningThreshold: 10,
            },
            {
              scope: "tokens",
              remaining: 200000,
              limit: 1000000,
              percentRemaining: 20,
              resetAt: "2099-04-17T02:00:00.000Z",
              warningThreshold: 10,
            },
          ],
          providerMeta: null,
        },
        runtimeLimitUpdatedAt: "2026-04-17T11:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("Runtime Usage")).toBeDefined();
    expect(screen.getByText("claude/anthropic sdk")).toBeDefined();
    expect(screen.getByText("Profile: Claude Team")).toBeDefined();
    expect(screen.getByText("5h")).toBeDefined();
    expect(screen.getByText("90% remaining")).toBeDefined();
    expect(screen.getByText("7d")).toBeDefined();
    expect(screen.getByText("62% remaining")).toBeDefined();
    expect(screen.getByText("codex/openai API")).toBeDefined();
    expect(screen.getByText("Profile: Codex API")).toBeDefined();
    expect(screen.getAllByText("Requests").length).toBeGreaterThan(0);
    expect(screen.getByText("12% remaining")).toBeDefined();
    expect(screen.getAllByText("Tokens").length).toBeGreaterThan(0);
    expect(screen.getByText("20% remaining")).toBeDefined();
  });

  it("shows no-signal state for runtimes without any provider usage snapshot", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-codex",
        projectId: "project-1",
        name: "Codex API",
        runtimeId: "codex",
        providerId: "openai",
        transport: "api",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.4",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: null,
        runtimeLimitUpdatedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("codex/openai API")).toBeDefined();
    expect(screen.getByText("Profile: Codex API")).toBeDefined();
    expect(screen.getByText("NO SIGNAL")).toBeDefined();
    expect(
      screen.getByText("No live quota window reported for this runtime/transport yet."),
    ).toBeDefined();
    expect(
      screen.getByText("Provider did not expose per-window quota details for this runtime."),
    ).toBeDefined();
    expect(screen.getByText("No recorded usage for this runtime profile yet.")).toBeDefined();
  });

  it("shows last usage even when a runtime transport exposes no quota snapshot", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-codex-sdk",
        projectId: "project-1",
        name: "gpt-5.4",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.4",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: null,
        runtimeLimitUpdatedAt: null,
        lastUsage: {
          inputTokens: 320,
          outputTokens: 88,
          totalTokens: 408,
          costUsd: 0.12,
        },
        lastUsageAt: "2026-04-18T10:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("codex/openai sdk")).toBeDefined();
    expect(screen.getByText("Profile: gpt-5.4")).toBeDefined();
    expect(screen.getByText("USAGE ONLY")).toBeDefined();
    expect(screen.getByText("320")).toBeDefined();
    expect(screen.getByText("88")).toBeDefined();
    expect(screen.getByText("408")).toBeDefined();
    expect(screen.getByText("$0.12")).toBeDefined();
  });

  it("derives a Claude-compatible provider label from baseUrl when only usage is available", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-claude-glm",
        projectId: "project-1",
        name: "Claude",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        defaultModel: "GLM-5-Turbo",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: null,
        runtimeLimitUpdatedAt: null,
        lastUsage: {
          inputTokens: 25869,
          outputTokens: 82,
          totalTokens: 25951,
          costUsd: 0.08,
        },
        lastUsageAt: "2026-04-18T15:33:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("Z.AI GLM Coding Plan claude/anthropic sdk")).toBeDefined();
    expect(screen.getByText("Profile: Claude")).toBeDefined();
    expect(screen.getByText("USAGE ONLY")).toBeDefined();
    expect(screen.getByText("25,951")).toBeDefined();
  });

  it("shows GLM model and tool usage summaries from Z.AI provider metadata", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-claude-glm",
        projectId: "project-1",
        name: "Claude",
        runtimeId: "claude",
        providerId: "anthropic",
        transport: "sdk",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        defaultModel: "GLM-5-Turbo",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "provider_api",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T15:33:00.000Z",
          providerId: "anthropic",
          runtimeId: "claude",
          profileId: "profile-claude-glm",
          primaryScope: "tokens",
          resetAt: "2099-04-18T17:00:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "tokens",
              name: "5h",
              percentRemaining: 99,
              resetAt: "2099-04-18T17:00:00.000Z",
            },
            {
              scope: "tool_usage",
              name: "MCP",
              percentRemaining: 100,
              resetAt: "2099-05-01T00:00:00.000Z",
            },
          ],
          providerMeta: {
            providerFamily: "zai-glm-coding",
            providerLabel: "Z.AI GLM Coding Plan",
            planType: "pro",
            modelUsageSummary: {
              sampledAt: "2026-04-18 15:00",
              granularity: "hourly",
              totalModelCallCount: 42,
              totalTokensUsage: 1200,
              windowHours: 24,
              topModels: [
                { modelName: "GLM-5.1", totalTokens: 900 },
                { modelName: "GLM-5-Turbo", totalTokens: 300 },
              ],
            },
            toolUsageSummary: {
              sampledAt: "2026-04-18 15:00",
              granularity: "hourly",
              totalNetworkSearchCount: 3,
              totalWebReadMcpCount: 7,
              totalZreadMcpCount: 2,
              totalSearchMcpCount: 12,
              windowHours: 24,
              tools: [
                { toolName: "web-reader", totalCount: 7 },
                { toolName: "search-prime", totalCount: 3 },
              ],
            },
          },
        },
        runtimeLimitUpdatedAt: "2026-04-18T15:33:00.000Z",
        lastUsage: {
          inputTokens: 25869,
          outputTokens: 82,
          totalTokens: 25951,
          costUsd: 0.08,
        },
        lastUsageAt: "2026-04-18T15:33:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("Recent Model Usage")).toBeDefined();
    expect(screen.getByText("Recent Tool Usage")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Show details" })).toHaveLength(2);

    const detailButtons = screen.getAllByRole("button", { name: "Show details" });
    fireEvent.click(detailButtons[0]);
    fireEvent.click(detailButtons[1]);

    expect(screen.getByText("CALLS 42")).toBeDefined();
    expect(screen.getByText("TOKENS 1.2K")).toBeDefined();
    expect(screen.getAllByText("24H WINDOW").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HOURLY").length).toBeGreaterThan(0);
    expect(screen.getByText("GLM-5.1")).toBeDefined();
    expect(screen.getByText("900 tokens")).toBeDefined();
    expect(screen.getByText("SEARCH 3")).toBeDefined();
    expect(screen.getByText("WEB READ 7")).toBeDefined();
    expect(screen.getByText("ZREAD 2")).toBeDefined();
    expect(screen.getByText("web-reader")).toBeDefined();
    expect(screen.getByText("7 calls")).toBeDefined();
  });

  it("merges local Codex profiles that share the same account quota", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-codex-cli",
        projectId: "project-1",
        name: "CLI gpt-5.3-codex",
        runtimeId: "codex",
        providerId: "openai",
        transport: "cli",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T05:21:00.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-cli",
          primaryScope: "time",
          resetAt: "2099-04-18T07:02:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 96,
              resetAt: "2099-04-18T07:02:00.000Z",
            },
            {
              scope: "time",
              name: "7d",
              percentRemaining: 95,
              resetAt: "2099-04-23T16:55:00.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
            limitId: "codex",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-18T05:21:00.000Z",
        lastUsage: {
          inputTokens: 1382445,
          outputTokens: 9865,
          totalTokens: 1392310,
        },
        lastUsageAt: "2026-04-18T05:21:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "profile-codex-sdk",
        projectId: "project-1",
        name: "gpt-5.4",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.4",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T05:24:00.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-sdk",
          primaryScope: "time",
          resetAt: "2099-04-18T07:02:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 96,
              resetAt: "2099-04-18T07:02:00.000Z",
            },
            {
              scope: "time",
              name: "7d",
              percentRemaining: 95,
              resetAt: "2099-04-23T16:55:00.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
            limitId: "codex",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-18T05:24:00.000Z",
        lastUsage: {
          inputTokens: 435229,
          outputTokens: 6455,
          totalTokens: 441684,
        },
        lastUsageAt: "2026-04-18T05:24:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getAllByText("Anton Ageev Pro codex/openai sdk/cli")).toHaveLength(1);
    expect(screen.getByText("Profiles: CLI gpt-5.3-codex, gpt-5.4")).toBeDefined();
    expect(screen.getByText("441,684")).toBeDefined();
  });

  it("keeps local Codex profiles separate when account is shared but limit pool differs", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-codex-spark",
        projectId: "project-1",
        name: "gpt-5.3-codex-spark",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex-spark",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T05:21:00.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-spark",
          primaryScope: "time",
          resetAt: "2099-04-18T07:02:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 96,
              resetAt: "2099-04-18T07:02:00.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
            limitId: "codex",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-18T05:21:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "profile-codex-standard",
        projectId: "project-1",
        name: "gpt-5.3-codex",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-18T05:24:00.000Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-standard",
          primaryScope: "time",
          resetAt: "2099-04-18T07:02:00.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 96,
              resetAt: "2099-04-18T07:02:00.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
            limitId: "codex_bengalfox",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-18T05:24:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("Profile: gpt-5.3-codex-spark")).toBeDefined();
    expect(screen.getByText("Profile: gpt-5.3-codex")).toBeDefined();
    expect(screen.queryByText(/^Profiles:/)).toBeNull();
    expect(screen.getByText("Limit pool: codex")).toBeDefined();
    expect(screen.getByText("Limit pool: codex_bengalfox")).toBeDefined();
  });

  it("keeps local Codex profiles separate by model when the account is shared but limit pool is unknown", () => {
    mockRuntimeProfiles = [
      {
        id: "profile-codex-spark",
        projectId: "project-1",
        name: "cli gpt-5.3-codex-spark",
        runtimeId: "codex",
        providerId: "openai",
        transport: "cli",
        baseUrl: null,
        apiKeyEnvVar: null,
        defaultModel: "gpt-5.3-codex-spark",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-19T10:09:46.091Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-spark",
          primaryScope: "time",
          resetAt: "2099-04-19T13:04:58.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 95,
              resetAt: "2099-04-19T13:04:58.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-19T10:09:47.258Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "profile-codex-gpt54",
        projectId: "project-1",
        name: "gpt-5.4",
        runtimeId: "codex",
        providerId: "openai",
        transport: "sdk",
        baseUrl: null,
        apiKeyEnvVar: null,
        defaultModel: "gpt-5.4",
        headers: {},
        options: {},
        enabled: true,
        runtimeLimitSnapshot: {
          source: "sdk_event",
          status: "ok",
          precision: "exact",
          checkedAt: "2026-04-19T10:13:34.496Z",
          providerId: "openai",
          runtimeId: "codex",
          profileId: "profile-codex-gpt54",
          primaryScope: "time",
          resetAt: "2099-04-19T13:04:58.000Z",
          warningThreshold: 10,
          windows: [
            {
              scope: "time",
              name: "5h",
              percentRemaining: 95,
              resetAt: "2099-04-19T13:04:58.000Z",
            },
          ],
          providerMeta: {
            accountId: "account-codex-1",
            accountName: "Anton Ageev",
            planType: "pro",
          },
        },
        runtimeLimitUpdatedAt: "2026-04-19T10:13:35.054Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Runtime usage" }));

    expect(screen.getByText("Profile: cli gpt-5.3-codex-spark")).toBeDefined();
    expect(screen.getByText("Profile: gpt-5.4")).toBeDefined();
    expect(screen.queryByText("Profiles: cli gpt-5.3-codex-spark, gpt-5.4")).toBeNull();
  });
});
