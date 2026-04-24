import { describe, expect, it } from "vitest";
import {
  ClaudeProviderFamily,
  resolveClaudeProviderAuth,
  resolveClaudeProviderIdentity,
} from "../adapters/claude/providerIdentity.js";

describe("resolveClaudeProviderIdentity", () => {
  it("classifies Z.AI anthropic-compatible endpoints as coding-plan backends", async () => {
    const identity = await resolveClaudeProviderIdentity({
      providerId: "anthropic",
      transport: "api",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKey: "zai-secret-token",
    });

    expect(identity).toMatchObject({
      providerFamily: ClaudeProviderFamily.ZAI_GLM_CODING,
      providerLabel: "Z.AI GLM Coding Plan",
      quotaSource: "zai_monitor",
      baseOrigin: "https://api.z.ai",
    });
    expect(identity.accountFingerprint).toHaveLength(16);
  });

  it("classifies Alibaba coding-plan anthropic endpoints separately", async () => {
    const identity = await resolveClaudeProviderIdentity({
      providerId: "anthropic",
      transport: "api",
      baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      apiKey: "sk-sp-aliyun-coding-plan",
    });

    expect(identity).toMatchObject({
      providerFamily: ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC,
      providerLabel: "Alibaba Coding Plan",
      quotaSource: "none",
      baseOrigin: "https://coding.dashscope.aliyuncs.com",
    });
    expect(identity.accountFingerprint).toHaveLength(16);
  });

  it("treats explicit Anthropic endpoints as native Anthropic", async () => {
    const identity = await resolveClaudeProviderIdentity({
      providerId: "anthropic",
      transport: "api",
      baseUrl: "https://api.anthropic.com/v1/messages",
      apiKey: "anthropic-native-key",
    });

    expect(identity).toMatchObject({
      providerFamily: ClaudeProviderFamily.ANTHROPIC_NATIVE,
      providerLabel: "Anthropic",
      quotaSource: "headers",
      baseOrigin: "https://api.anthropic.com",
    });
    expect(identity.accountFingerprint).toHaveLength(16);
  });

  it("prefers local Claude auth tokens for Z.AI sdk quota refresh over resolved API keys", () => {
    const localSettings = {
      baseUrl: "https://api.z.ai/api/anthropic",
      authToken: "glm-local-auth-token",
    };

    const resolved = resolveClaudeProviderAuth({
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKey: "sk-resolved-api-key",
      localSettingsOverride: localSettings,
    });

    expect(resolved.authToken).toBe("glm-local-auth-token");
    expect(resolved.identity).toMatchObject({
      providerFamily: ClaudeProviderFamily.ZAI_GLM_CODING,
      providerLabel: "Z.AI GLM Coding Plan",
      quotaSource: "zai_monitor",
      baseOrigin: "https://api.z.ai",
      apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
    });
    expect(resolved.identity.accountFingerprint).toHaveLength(16);
  });

  it("keeps explicit API keys for Z.AI API transport", () => {
    const resolved = resolveClaudeProviderAuth({
      providerId: "anthropic",
      transport: "api",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKeyEnvVar: "ZAI_API_KEY",
      apiKey: "zai-api-key",
      localSettingsOverride: {
        baseUrl: "https://api.z.ai/api/anthropic",
        authToken: "glm-local-auth-token",
      },
    });

    expect(resolved.authToken).toBe("zai-api-key");
    expect(resolved.identity).toMatchObject({
      providerFamily: ClaudeProviderFamily.ZAI_GLM_CODING,
      quotaSource: "zai_monitor",
      apiKeyEnvVar: "ZAI_API_KEY",
    });
  });
});
