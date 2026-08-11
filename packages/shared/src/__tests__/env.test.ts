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
      API_RUNTIME_START_TIMEOUT_MS: "45000",
      API_RUNTIME_RUN_TIMEOUT_MS: "240000",
      DATABASE_URL: "./data/test.sqlite",
      AGENT_QUERY_AUDIT_ENABLED: "false",
      LOG_LEVEL: "debug",
    });

    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(result.PORT).toBe(3009);
    expect(result.POLL_INTERVAL_MS).toBe(30000);
    expect(result.AGENT_QUERY_START_TIMEOUT_MS).toBe(20000);
    expect(result.AGENT_QUERY_START_RETRY_DELAY_MS).toBe(250);
    expect(result.API_RUNTIME_START_TIMEOUT_MS).toBe(45000);
    expect(result.API_RUNTIME_RUN_TIMEOUT_MS).toBe(240000);
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
    expect(result.API_RUNTIME_START_TIMEOUT_MS).toBe(60 * 1000);
    expect(result.API_RUNTIME_RUN_TIMEOUT_MS).toBe(120 * 1000);
    expect(result.DATABASE_URL).toBe("./data/aif.sqlite");
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OPENAI_BASE_URL).toBeUndefined();
    expect(result.OPENAI_MODEL).toBeUndefined();
    expect(result.CODEX_CLI_PATH).toBeUndefined();
    expect(result.AIF_RUNTIME_MODULES).toEqual([]);
    expect(result.TELEGRAM_BOT_API_URL).toBeUndefined();
    expect(result.AGENT_QUERY_AUDIT_ENABLED).toBe(true);
    expect(result.LOG_LEVEL).toBe("debug");
    expect(result.ACTIVITY_LOG_MODE).toBe("sync");
    expect(result.ACTIVITY_LOG_BATCH_SIZE).toBe(20);
    expect(result.ACTIVITY_LOG_BATCH_MAX_AGE_MS).toBe(5000);
    expect(result.ACTIVITY_LOG_QUEUE_LIMIT).toBe(500);
    expect(result.AGENT_WAKE_ENABLED).toBe(true);
    expect(result.COORDINATOR_MAX_CONCURRENT_TASKS).toBe(12);
    expect(result.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT).toBe(3);
    expect(result.COORDINATOR_MAX_CONCURRENT_PROJECTS).toBe(4);
    expect(result.AGENT_CHAT_MAX_TURNS).toBe(50);
    expect(result.AGENT_MAX_REVIEW_ITERATIONS).toBe(3);
    expect(result.AGENT_USE_SUBAGENTS).toBe(false);
    expect(result.AIF_WARMUP_ENABLED).toBe(false);
    expect(result.AIF_STAGE_RUNTIME_PIN_ENABLED).toBe(false);
    expect(result.AIF_TASK_WORKTREES_ENABLED).toBe(false);
    expect(result.AIF_RUNTIME_SESSION_FORK_ENABLED).toBe(false);
    expect(result.AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED).toBe(false);
    expect(result.AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED).toBe(false);
    expect(result.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED).toBe(false);
    expect(result.AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED).toBe(false);
    expect(result.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED).toBe(false);
    expect(result.AIF_GITHUB_ISSUE_PR_ENABLED).toBe(false);
    expect(result.AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED).toBe(false);
    expect(result.PARTICIPANTS_MODE_ENABLED).toBe(false);
    expect(result.PARTICIPANT_SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(result.PARTICIPANT_SESSION_COOKIE_NAME).toBe("aif_participant_session");
    expect(result.PARTICIPANT_SESSION_COOKIE_SECURE).toBe(false);
    expect(result.PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(result.PARTICIPANT_LOGIN_RATE_LIMIT_MAX).toBe(10);
    expect(result.PARTICIPANT_ALLOWED_ORIGINS).toEqual(["http://localhost:5180"]);
  });

  it("parses Participants Mode security settings", () => {
    const result = validateEnv({
      PARTICIPANTS_MODE_ENABLED: "true",
      PARTICIPANT_SESSION_TTL_SECONDS: "3600",
      PARTICIPANT_SESSION_COOKIE_NAME: "team_session",
      PARTICIPANT_SESSION_COOKIE_SECURE: "yes",
      PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS: "120000",
      PARTICIPANT_LOGIN_RATE_LIMIT_MAX: "4",
      PARTICIPANT_ALLOWED_ORIGINS: "https://team.example.test, http://localhost:5180/",
    });

    expect(result.PARTICIPANTS_MODE_ENABLED).toBe(true);
    expect(result.PARTICIPANT_SESSION_TTL_SECONDS).toBe(3600);
    expect(result.PARTICIPANT_SESSION_COOKIE_NAME).toBe("team_session");
    expect(result.PARTICIPANT_SESSION_COOKIE_SECURE).toBe(true);
    expect(result.PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS).toBe(120_000);
    expect(result.PARTICIPANT_LOGIN_RATE_LIMIT_MAX).toBe(4);
    expect(result.PARTICIPANT_ALLOWED_ORIGINS).toEqual([
      "https://team.example.test",
      "http://localhost:5180",
    ]);
  });

  it("rejects wildcard and non-origin Participants Mode origins", () => {
    expect(() => validateEnv({ PARTICIPANT_ALLOWED_ORIGINS: "*" })).toThrow();
    expect(() =>
      validateEnv({ PARTICIPANT_ALLOWED_ORIGINS: "https://team.example.test/path" }),
    ).toThrow();
  });

  it("should parse AIF_WARMUP_ENABLED boolean values", () => {
    expect(validateEnv({ AIF_WARMUP_ENABLED: "true" }).AIF_WARMUP_ENABLED).toBe(true);
    expect(validateEnv({ AIF_WARMUP_ENABLED: "1" }).AIF_WARMUP_ENABLED).toBe(true);
    expect(validateEnv({ AIF_WARMUP_ENABLED: "false" }).AIF_WARMUP_ENABLED).toBe(false);
    expect(validateEnv({ AIF_WARMUP_ENABLED: "0" }).AIF_WARMUP_ENABLED).toBe(false);
  });

  it("should parse the Telegram project-name rollout flag", () => {
    expect(
      validateEnv({ AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED: "true" })
        .AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED: "false" })
        .AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED,
    ).toBe(false);
  });

  it("should parse runtime rollout boolean flags", () => {
    const enabled = validateEnv({
      AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED: "yes",
      AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED: "on",
      AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED: "true",
      AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED: "1",
      AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED: "yes",
      AIF_STAGE_RUNTIME_PIN_ENABLED: "true",
      AIF_GITHUB_ISSUE_PR_ENABLED: "yes",
    });
    expect(enabled.AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED).toBe(true);
    expect(enabled.AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED).toBe(true);
    expect(enabled.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED).toBe(true);
    expect(enabled.AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED).toBe(true);
    expect(enabled.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED).toBe(true);
    expect(enabled.AIF_STAGE_RUNTIME_PIN_ENABLED).toBe(true);
    expect(enabled.AIF_GITHUB_ISSUE_PR_ENABLED).toBe(true);

    const disabled = validateEnv({
      AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED: "no",
      AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED: "off",
      AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED: "false",
      AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED: "0",
      AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED: "off",
      AIF_STAGE_RUNTIME_PIN_ENABLED: "0",
      AIF_GITHUB_ISSUE_PR_ENABLED: "off",
    });
    expect(disabled.AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED).toBe(false);
    expect(disabled.AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED).toBe(false);
    expect(disabled.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED).toBe(false);
    expect(disabled.AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED).toBe(false);
    expect(disabled.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED).toBe(false);
    expect(disabled.AIF_STAGE_RUNTIME_PIN_ENABLED).toBe(false);
    expect(disabled.AIF_GITHUB_ISSUE_PR_ENABLED).toBe(false);
  });

  it("should reject invalid stage runtime pin flag values", () => {
    expect(() =>
      validateEnv({
        AIF_STAGE_RUNTIME_PIN_ENABLED: "maybe",
      }),
    ).toThrow();
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
