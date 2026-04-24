import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchZaiClaudeQuotaSnapshot } from "../adapters/claude/zaiQuota.js";

const originalFetch = global.fetch;

describe("fetchZaiClaudeQuotaSnapshot", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes Z.AI quota payloads into exact runtime-limit snapshots", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            level: "pro",
            limits: [
              {
                type: "TIME_LIMIT",
                usage: 1000,
                currentValue: 125,
                remaining: 875,
                percentage: 12.5,
                nextResetTime: 1_800_000_000_000,
                usageDetails: [{ modelCode: "web-reader", usage: 12 }],
              },
              {
                type: "TOKENS_LIMIT",
                percentage: 4,
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            x_time: ["2026-04-18 09:00", "2026-04-18 10:00"],
            granularity: "hourly",
            totalUsage: {
              totalModelCallCount: 42,
              totalTokensUsage: 987654,
              modelSummaryList: [
                { modelName: "GLM-5.1", totalTokens: 876543, sortOrder: 1 },
                { modelName: "GLM-5-Turbo", totalTokens: 111111, sortOrder: 2 },
              ],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            x_time: ["2026-04-18 09:00", "2026-04-18 10:00"],
            granularity: "hourly",
            totalUsage: {
              totalNetworkSearchCount: 3,
              totalWebReadMcpCount: 7,
              totalZreadMcpCount: 2,
              totalSearchMcpCount: 12,
              toolSummaryList: [
                { toolName: "web-reader", totalCount: 7 },
                { toolName: "search-prime", totalCount: 3 },
              ],
            },
          },
        }),
      }) as typeof fetch;

    const snapshot = await fetchZaiClaudeQuotaSnapshot({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-zai",
      authToken: "secret-token",
      identity: {
        providerFamily: "zai-glm-coding",
        providerLabel: "Z.AI GLM Coding Plan",
        quotaSource: "zai_monitor",
        baseUrl: "https://api.z.ai/api/anthropic",
        baseOrigin: "https://api.z.ai",
        apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
        accountFingerprint: "glm-account-1",
        accountLabel: null,
      },
      checkedAt: "2026-04-18T10:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      source: "provider_api",
      status: "ok",
      precision: "exact",
      checkedAt: "2026-04-18T10:00:00.000Z",
      providerId: "anthropic",
      runtimeId: "claude",
      profileId: "profile-zai",
      primaryScope: "tool_usage",
      providerMeta: {
        providerFamily: "zai-glm-coding",
        providerLabel: "Z.AI GLM Coding Plan",
        quotaSource: "zai_monitor",
        accountFingerprint: "glm-account-1",
        planType: "pro",
        modelUsageSummary: {
          granularity: "hourly",
          sampledAt: "2026-04-18 10:00",
          totalModelCallCount: 42,
          totalTokensUsage: 987654,
          windowHours: 24,
          topModels: [
            { modelName: "GLM-5.1", totalTokens: 876543, sortOrder: 1 },
            { modelName: "GLM-5-Turbo", totalTokens: 111111, sortOrder: 2 },
          ],
        },
        toolUsageSummary: {
          granularity: "hourly",
          sampledAt: "2026-04-18 10:00",
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
    });
    expect(snapshot?.windows).toEqual([
      expect.objectContaining({
        scope: "tool_usage",
        name: "MCP",
        used: 125,
        remaining: 875,
        limit: 1000,
        percentUsed: 12.5,
        percentRemaining: 87.5,
        resetAt: new Date(1_800_000_000_000).toISOString(),
      }),
      expect.objectContaining({
        scope: "tokens",
        name: "5h",
        percentUsed: 4,
        percentRemaining: 96,
      }),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("selects resetAt and primaryScope from the violated Z.AI window instead of the first window", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            level: "pro",
            limits: [
              {
                type: "TIME_LIMIT",
                usage: 1000,
                currentValue: 100,
                remaining: 900,
                percentage: 10,
                nextResetTime: 1_800_000_000_000,
              },
              {
                type: "TOKENS_LIMIT",
                percentage: 96,
                nextResetTime: 1_800_100_000_000,
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 200, success: true, data: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 200, success: true, data: {} }),
      }) as typeof fetch;

    const snapshot = await fetchZaiClaudeQuotaSnapshot({
      runtimeId: "claude",
      providerId: "anthropic",
      profileId: "profile-zai",
      authToken: "secret-token",
      identity: {
        providerFamily: "zai-glm-coding",
        providerLabel: "Z.AI GLM Coding Plan",
        quotaSource: "zai_monitor",
        baseUrl: "https://api.z.ai/api/anthropic",
        baseOrigin: "https://api.z.ai",
        apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
        accountFingerprint: "glm-account-1",
        accountLabel: null,
      },
      checkedAt: "2026-04-18T10:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      status: "warning",
      primaryScope: "tokens",
      resetAt: new Date(1_800_100_000_000).toISOString(),
      providerMeta: {
        quotaSource: "zai_monitor",
      },
    });
    expect(snapshot?.windows).toEqual([
      expect.objectContaining({
        scope: "tool_usage",
        percentRemaining: 90,
        resetAt: new Date(1_800_000_000_000).toISOString(),
      }),
      expect.objectContaining({
        scope: "tokens",
        percentRemaining: 4,
        resetAt: new Date(1_800_100_000_000).toISOString(),
      }),
    ]);
  });

  it("returns null for non-Z.AI provider families", async () => {
    const snapshot = await fetchZaiClaudeQuotaSnapshot({
      runtimeId: "claude",
      providerId: "anthropic",
      authToken: "secret-token",
      identity: {
        providerFamily: "anthropic-native",
        providerLabel: "Anthropic",
        quotaSource: "sdk_event",
        baseUrl: null,
        baseOrigin: "https://api.anthropic.com",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        accountFingerprint: null,
        accountLabel: null,
      },
    });

    expect(snapshot).toBeNull();
  });
});
