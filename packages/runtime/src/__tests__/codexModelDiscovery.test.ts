import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexAppServerDiscoveryEnv } from "../adapters/codex/modelDiscovery.js";

describe("codex app-server model discovery env", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not forward ambient OPENAI_BASE_URL into app-server discovery env", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");

    const env = buildCodexAppServerDiscoveryEnv({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      options: {},
    });

    expect(env.OPENAI_API_KEY).toBe("sk-env");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("maps an explicit discovery baseUrl to CODEX_BASE_URL only", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");

    const env = buildCodexAppServerDiscoveryEnv({
      runtimeId: "codex",
      providerId: "openai",
      profileId: "profile-1",
      baseUrl: "https://runtime.example.com/v1",
      options: {},
    });

    expect(env.CODEX_BASE_URL).toBe("https://runtime.example.com/v1");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});
