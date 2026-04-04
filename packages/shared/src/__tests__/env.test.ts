import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateEnv } from "../env.js";

describe("env validation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should pass with valid config", () => {
    const result = validateEnv({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      PORT: "3009",
      POLL_INTERVAL_MS: "30000",
      AGENT_QUERY_START_TIMEOUT_MS: "20000",
      AGENT_QUERY_START_RETRY_DELAY_MS: "250",
      DATABASE_URL: "./data/test.sqlite",
      AGENT_QUERY_AUDIT_ENABLED: "false",
      LOG_LEVEL: "debug",
    });

    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(result.PORT).toBe(3009);
    expect(result.POLL_INTERVAL_MS).toBe(30000);
    expect(result.AGENT_QUERY_START_TIMEOUT_MS).toBe(20000);
    expect(result.AGENT_QUERY_START_RETRY_DELAY_MS).toBe(250);
    expect(result.DATABASE_URL).toBe("./data/test.sqlite");
    expect(result.AGENT_QUERY_AUDIT_ENABLED).toBe(false);
    expect(result.LOG_LEVEL).toBe("debug");
  });

  it("should apply defaults for optional fields", () => {
    const result = validateEnv({});

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.ANTHROPIC_MODEL).toBeUndefined();
    expect(result.PORT).toBe(3009);
    expect(result.POLL_INTERVAL_MS).toBe(30000);
    expect(result.AGENT_STAGE_STALE_TIMEOUT_MS).toBe(90 * 60 * 1000);
    expect(result.AGENT_STAGE_STALE_MAX_RETRY).toBe(3);
    expect(result.AGENT_STAGE_RUN_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(result.AGENT_QUERY_START_TIMEOUT_MS).toBe(60 * 1000);
    expect(result.AGENT_QUERY_START_RETRY_DELAY_MS).toBe(1000);
    expect(result.DATABASE_URL).toBe("./data/aif.sqlite");
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OPENAI_BASE_URL).toBeUndefined();
    expect(result.OPENAI_MODEL).toBeUndefined();
    expect(result.CODEX_CLI_PATH).toBeUndefined();
    expect(result.AGENTAPI_BASE_URL).toBeUndefined();
    expect(result.AIF_RUNTIME_MODULES).toEqual([]);
    expect(result.AGENT_QUERY_AUDIT_ENABLED).toBe(true);
    expect(result.LOG_LEVEL).toBe("debug");
    expect(result.ACTIVITY_LOG_MODE).toBe("sync");
    expect(result.ACTIVITY_LOG_BATCH_SIZE).toBe(20);
    expect(result.ACTIVITY_LOG_BATCH_MAX_AGE_MS).toBe(5000);
    expect(result.ACTIVITY_LOG_QUEUE_LIMIT).toBe(500);
    expect(result.AGENT_WAKE_ENABLED).toBe(true);
    expect(result.AGENT_MAX_REVIEW_ITERATIONS).toBe(3);
    expect(result.AGENT_USE_SUBAGENTS).toBe(true);
  });

  it("should accept missing ANTHROPIC_API_KEY (uses ~/.claude/ auth)", () => {
    const result = validateEnv({});
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("should coerce PORT to number", () => {
    const result = validateEnv({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      PORT: "8080",
    });
    expect(result.PORT).toBe(8080);
  });

  it("should accept batch activity log mode with custom limits", () => {
    const result = validateEnv({
      ACTIVITY_LOG_MODE: "batch",
      ACTIVITY_LOG_BATCH_SIZE: "50",
      ACTIVITY_LOG_BATCH_MAX_AGE_MS: "10000",
      ACTIVITY_LOG_QUEUE_LIMIT: "1000",
    });

    expect(result.ACTIVITY_LOG_MODE).toBe("batch");
    expect(result.ACTIVITY_LOG_BATCH_SIZE).toBe(50);
    expect(result.ACTIVITY_LOG_BATCH_MAX_AGE_MS).toBe(10000);
    expect(result.ACTIVITY_LOG_QUEUE_LIMIT).toBe(1000);
  });

  it("should fallback to sync for invalid ACTIVITY_LOG_MODE", () => {
    const result = validateEnv({
      ACTIVITY_LOG_MODE: "invalid_mode",
    });

    expect(result.ACTIVITY_LOG_MODE).toBe("sync");
  });

  it("should accept sync activity log mode explicitly", () => {
    const result = validateEnv({
      ACTIVITY_LOG_MODE: "sync",
    });

    expect(result.ACTIVITY_LOG_MODE).toBe("sync");
  });

  it("should parse comma-separated runtime modules", () => {
    const result = validateEnv({
      AIF_RUNTIME_MODULES: "module-one, module-two ,,module-three",
    });

    expect(result.AIF_RUNTIME_MODULES).toEqual(["module-one", "module-two", "module-three"]);
  });

  it("should reject invalid LOG_LEVEL", () => {
    expect(() =>
      validateEnv({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        LOG_LEVEL: "invalid",
      }),
    ).toThrow();
  });

  it("getEnv should cache parsed environment", async () => {
    vi.stubEnv("PORT", "3200");
    vi.stubEnv("DATABASE_URL", "./data/cached.sqlite");
    const { getEnv } = await import("../env.js");

    const first = getEnv();
    vi.stubEnv("PORT", "9999");
    const second = getEnv();

    expect(first).toBe(second);
    expect(second.PORT).toBe(3200);
    vi.unstubAllEnvs();
  });

  it("getEnv should throw on invalid environment", async () => {
    vi.stubEnv("PORT", "not-a-number");
    const { getEnv } = await import("../env.js");
    expect(() => getEnv()).toThrow("Environment validation failed");
    vi.unstubAllEnvs();
  });
});
