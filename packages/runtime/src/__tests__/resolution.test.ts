import { describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeProfile,
  RuntimeValidationError,
  validateResolvedRuntimeProfile,
} from "../index.js";

describe("resolveRuntimeProfile", () => {
  it("merges profile settings with env and runtime overrides", () => {
    const resolved = resolveRuntimeProfile({
      source: "task_override",
      profile: {
        id: "profile-1",
        runtimeId: "codex",
        providerId: "openai",
        transport: "agentapi",
        baseUrl: null,
        apiKeyEnvVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.4",
        headers: { "x-org": "aif" },
        options: { approvalMode: "auto" },
        enabled: true,
      },
      env: {
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      },
      modelOverride: "gpt-5.4-mini",
      runtimeOptionsOverride: { approvalMode: "manual", region: "us" },
    });

    expect(resolved.profileId).toBe("profile-1");
    expect(resolved.runtimeId).toBe("codex");
    expect(resolved.transport).toBe("api");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.model).toBe("gpt-5.4-mini");
    expect(resolved.options).toEqual({
      approvalMode: "manual",
      region: "us",
    });
  });

  it("falls back to claude defaults when no profile is selected", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "claude",
      fallbackProviderId: "anthropic",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });

    expect(resolved.runtimeId).toBe("claude");
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(resolved.apiKey).toBe("sk-ant-test");
    expect(resolved.transport).toBe("sdk");
  });

  it("falls back to codex CLI defaults when no profile is selected", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "codex",
      fallbackProviderId: "openai",
      env: {},
    });

    expect(resolved.runtimeId).toBe("codex");
    expect(resolved.providerId).toBe("openai");
    expect(resolved.transport).toBe("cli");
  });

  it("falls back to ANTHROPIC_MODEL when profile/default overrides are missing", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "claude",
      fallbackProviderId: "anthropic",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_MODEL: "glm-4.5",
      },
    });

    expect(resolved.model).toBe("glm-4.5");
  });

  it("falls back to ANTHROPIC_AUTH_TOKEN when API key is not configured", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "claude",
      fallbackProviderId: "anthropic",
      env: {
        ANTHROPIC_AUTH_TOKEN: "token-test",
      },
    });

    expect(resolved.apiKeyEnvVar).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(resolved.apiKey).toBe("token-test");
  });

  it("falls back to inferred env var when profile apiKeyEnvVar is invalid", () => {
    const warn = vi.fn();
    const resolved = resolveRuntimeProfile({
      source: "profile_id",
      profile: {
        id: "profile-invalid-env-var",
        runtimeId: "claude",
        providerId: "anthropic",
        apiKeyEnvVar: "invalid env var",
      },
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
      logger: { warn },
    });

    expect(resolved.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(resolved.apiKey).toBe("sk-ant-test");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to inferred env var when configured apiKeyEnvVar is missing", () => {
    const warn = vi.fn();
    const resolved = resolveRuntimeProfile({
      source: "profile_id",
      profile: {
        id: "profile-missing-explicit-key",
        runtimeId: "claude",
        providerId: "anthropic",
        apiKeyEnvVar: "legacy.custom.key",
      },
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
      logger: { warn },
    });

    expect(resolved.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(resolved.apiKey).toBe("sk-ant-test");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("omits model fallback when suppressModelFallback=true", () => {
    const resolved = resolveRuntimeProfile({
      source: "task_override",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
        defaultModel: "profile-model",
      },
      modelOverride: "task-model",
      suppressModelFallback: true,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });

    expect(resolved.model).toBeNull();
  });

  it("throws when profile is disabled", () => {
    expect(() =>
      resolveRuntimeProfile({
        source: "task_override",
        profile: {
          id: "disabled-profile",
          runtimeId: "claude",
          providerId: "anthropic",
          enabled: false,
        },
      }),
    ).toThrow(RuntimeValidationError);
  });

  it("uses lightModelFallback when profile has no defaultModel and no env model", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "openrouter",
      fallbackProviderId: "openrouter",
      lightModelFallback: "meta-llama/llama-3-8b",
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
      },
    });

    expect(resolved.model).toBe("meta-llama/llama-3-8b");
  });

  it("prefers profile defaultModel over lightModelFallback", () => {
    const resolved = resolveRuntimeProfile({
      source: "task_override",
      profile: {
        id: "profile-1",
        runtimeId: "openrouter",
        providerId: "openrouter",
        defaultModel: "anthropic/claude-sonnet-4",
      },
      lightModelFallback: "meta-llama/llama-3-8b",
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
      },
    });

    expect(resolved.model).toBe("anthropic/claude-sonnet-4");
  });

  it("prefers modelOverride over lightModelFallback", () => {
    const resolved = resolveRuntimeProfile({
      source: "task_override",
      profile: {
        id: "profile-1",
        runtimeId: "claude",
        providerId: "anthropic",
      },
      modelOverride: "task-model",
      lightModelFallback: "haiku",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });

    expect(resolved.model).toBe("task-model");
  });

  it("resolves openrouter defaults with OPENROUTER_API_KEY", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "openrouter",
      fallbackProviderId: "openrouter",
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
      },
    });

    expect(resolved.runtimeId).toBe("openrouter");
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expect(resolved.apiKey).toBe("sk-or-test");
    expect(resolved.transport).toBe("api");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("resolves openrouter model from OPENROUTER_MODEL env", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "openrouter",
      fallbackProviderId: "openrouter",
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_MODEL: "openai/gpt-4o",
      },
    });

    expect(resolved.model).toBe("openai/gpt-4o");
  });

  it("resolves openrouter with custom base URL from env", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "openrouter",
      fallbackProviderId: "openrouter",
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_BASE_URL: "https://my-proxy.example.com/v1",
      },
    });

    expect(resolved.baseUrl).toBe("https://my-proxy.example.com/v1");
  });
});

describe("validateResolvedRuntimeProfile", () => {
  it("SDK transport passes without API key (session auth)", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "claude",
      fallbackProviderId: "anthropic",
      env: {},
    });

    const validation = validateResolvedRuntimeProfile(resolved);
    expect(resolved.transport).toBe("sdk");
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toHaveLength(0);
  });
});
