import { describe, expect, it } from "vitest";
import { validateResolvedRuntimeProfile, type ResolvedRuntimeProfile } from "../resolution.js";
import { RuntimeTransport } from "../types.js";

function profile(overrides: Partial<ResolvedRuntimeProfile> = {}): ResolvedRuntimeProfile {
  return {
    source: "test",
    profileId: null,
    runtimeId: "claude",
    providerId: "anthropic",
    transport: RuntimeTransport.SDK,
    baseUrl: null,
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    apiKey: null,
    model: null,
    headers: {},
    options: {},
    ...overrides,
  };
}

describe("validateResolvedRuntimeProfile", () => {
  it("SDK transport passes without API key", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.SDK,
        apiKey: null,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("SDK transport passes with API key", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.SDK,
        apiKey: "sk-test",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("CLI transport warns when codexCliPath missing", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.CLI,
        options: {},
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("codexCliPath"))).toBe(true);
  });

  it("CLI transport passes with codexCliPath", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.CLI,
        options: { codexCliPath: "/usr/bin/codex" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("CLI transport does not warn about API key", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.CLI,
        apiKey: null,
        options: { codexCliPath: "codex" },
      }),
    );
    expect(result.warnings.some((w) => w.includes("API key"))).toBe(false);
  });

  it("API transport warns when API key missing", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.API,
        apiKey: null,
        baseUrl: "https://api.example.com",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("API key"))).toBe(true);
  });

  it("API transport warns when base URL missing", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.API,
        apiKey: "sk-test",
        baseUrl: null,
        options: {},
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("base URL"))).toBe(true);
  });

  it("API transport passes with agentApiBaseUrl in options", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.API,
        apiKey: "sk-test",
        baseUrl: null,
        options: { agentApiBaseUrl: "http://localhost:8080" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("API transport passes with baseUrl on profile", () => {
    const result = validateResolvedRuntimeProfile(
      profile({
        transport: RuntimeTransport.API,
        apiKey: "sk-test",
        baseUrl: "https://api.example.com",
      }),
    );
    expect(result.ok).toBe(true);
  });
});
