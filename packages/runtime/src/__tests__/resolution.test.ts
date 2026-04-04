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
        AGENTAPI_BASE_URL: "http://localhost:8080",
      },
      modelOverride: "gpt-5.4-mini",
      runtimeOptionsOverride: { approvalMode: "manual", region: "us" },
    });

    expect(resolved.profileId).toBe("profile-1");
    expect(resolved.runtimeId).toBe("codex");
    expect(resolved.transport).toBe("agentapi");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.model).toBe("gpt-5.4-mini");
    expect(resolved.options).toEqual({
      approvalMode: "manual",
      region: "us",
      agentApiBaseUrl: "http://localhost:8080",
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
});

describe("validateResolvedRuntimeProfile", () => {
  it("returns warning when API key is missing for SDK transport", () => {
    const resolved = resolveRuntimeProfile({
      source: "none",
      profile: null,
      fallbackRuntimeId: "claude",
      fallbackProviderId: "anthropic",
      env: {},
    });

    const validation = validateResolvedRuntimeProfile(resolved);
    expect(validation.ok).toBe(false);
    expect(validation.warnings[0]).toContain("Missing API key env var");
  });
});
