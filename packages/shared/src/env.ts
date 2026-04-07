import { z } from "zod";
import { logger } from "./logger.js";

const log = logger("env");
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const ACTIVITY_LOG_MODES = ["sync", "batch"] as const;

function parseRuntimeModules(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  CODEX_CLI_PATH: z.string().optional(),
  AGENTAPI_BASE_URL: z.string().optional(),
  AIF_RUNTIME_MODULES: z.preprocess(parseRuntimeModules, z.array(z.string())).default([]),
  AIF_DEFAULT_RUNTIME_ID: z.string().default("claude"),
  AIF_DEFAULT_PROVIDER_ID: z.string().default("anthropic"),
  PORT: z.coerce.number().default(3009),
  POLL_INTERVAL_MS: z.coerce.number().default(30000),
  AGENT_STAGE_STALE_TIMEOUT_MS: z.coerce.number().default(90 * 60 * 1000),
  AGENT_STAGE_STALE_MAX_RETRY: z.coerce.number().default(3),
  AGENT_STAGE_RUN_TIMEOUT_MS: z.coerce.number().default(60 * 60 * 1000),
  AGENT_QUERY_START_TIMEOUT_MS: z.coerce.number().default(60 * 1000),
  AGENT_QUERY_START_RETRY_DELAY_MS: z.coerce.number().default(1000),
  DATABASE_URL: z.string().default("./data/aif.sqlite"),
  CORS_ORIGIN: z.string().default("*"),
  API_BASE_URL: z.string().default("http://localhost:3009"),
  AGENT_QUERY_AUDIT_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("debug"),
  ACTIVITY_LOG_MODE: z
    .preprocess((value) => {
      if (typeof value !== "string") return "sync";
      const normalized = value.trim().toLowerCase();
      if (!(ACTIVITY_LOG_MODES as readonly string[]).includes(normalized)) {
        log.warn(
          { value, fallback: "sync" },
          "Invalid ACTIVITY_LOG_MODE value, falling back to sync",
        );
        return "sync";
      }
      return normalized;
    }, z.enum(ACTIVITY_LOG_MODES))
    .default("sync"),
  ACTIVITY_LOG_BATCH_SIZE: z.coerce.number().min(1).default(20),
  ACTIVITY_LOG_BATCH_MAX_AGE_MS: z.coerce.number().min(100).default(5000),
  ACTIVITY_LOG_QUEUE_LIMIT: z.coerce.number().min(1).default(500),
  AGENT_WAKE_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  AGENT_BYPASS_PERMISSIONS: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  COORDINATOR_MAX_CONCURRENT_TASKS: z.coerce.number().min(1).max(10).default(3),
  AGENT_MAX_REVIEW_ITERATIONS: z.coerce.number().min(1).default(3),
  AGENT_USE_SUBAGENTS: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_USER_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

function warnOnRuntimeDefaults(env: Env): void {
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    log.warn(
      { hasAnthropicBaseUrl: true, hasAnthropicApiKey: false, hasAnthropicAuthToken: false },
      "ANTHROPIC_BASE_URL is configured without ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN",
    );
  }

  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) {
    log.warn(
      { hasAnthropicBaseUrl: true, hasAnthropicModel: false },
      "ANTHROPIC_BASE_URL is configured without ANTHROPIC_MODEL; set it if your proxy requires explicit model",
    );
  }

  if (env.OPENAI_BASE_URL && !env.OPENAI_API_KEY) {
    log.warn(
      { hasOpenAiBaseUrl: true, hasOpenAiApiKey: false },
      "OPENAI_BASE_URL is configured without OPENAI_API_KEY",
    );
  }

  if (env.AGENTAPI_BASE_URL && !env.OPENAI_API_KEY) {
    log.warn(
      { hasAgentApiBaseUrl: true, hasOpenAiApiKey: false },
      "AGENTAPI_BASE_URL is configured without OPENAI_API_KEY",
    );
  }

  const deduplicatedModules = [...new Set(env.AIF_RUNTIME_MODULES)];
  if (deduplicatedModules.length !== env.AIF_RUNTIME_MODULES.length) {
    log.warn(
      {
        configuredCount: env.AIF_RUNTIME_MODULES.length,
        deduplicatedCount: deduplicatedModules.length,
      },
      "AIF_RUNTIME_MODULES contains duplicate entries",
    );
  }
}

export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    log.fatal({ errors: formatted }, "Environment validation failed");
    throw new Error(`Environment validation failed: ${JSON.stringify(formatted)}`);
  }

  _env = result.data;
  warnOnRuntimeDefaults(_env);
  log.debug({ port: _env.PORT, dbUrl: _env.DATABASE_URL }, "Environment loaded");
  log.info(
    {
      runtimeModulesCount: _env.AIF_RUNTIME_MODULES.length,
      hasAnthropicBaseUrl: Boolean(_env.ANTHROPIC_BASE_URL),
      hasAnthropicModel: Boolean(_env.ANTHROPIC_MODEL),
      hasOpenAiBaseUrl: Boolean(_env.OPENAI_BASE_URL),
      hasAgentApiBaseUrl: Boolean(_env.AGENTAPI_BASE_URL),
      hasCodexCliPath: Boolean(_env.CODEX_CLI_PATH),
    },
    "Runtime environment defaults resolved",
  );
  log.info({ mode: _env.ACTIVITY_LOG_MODE }, "Activity logging mode selected");
  log.debug(
    {
      mode: _env.ACTIVITY_LOG_MODE,
      batchSize: _env.ACTIVITY_LOG_BATCH_SIZE,
      maxAgeMs: _env.ACTIVITY_LOG_BATCH_MAX_AGE_MS,
      queueLimit: _env.ACTIVITY_LOG_QUEUE_LIMIT,
    },
    "Resolved activity-log config",
  );
  return _env;
}

/** Validate env without caching — useful for testing */
export function validateEnv(env: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(env);
}
