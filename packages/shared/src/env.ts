import { z } from "zod";
import { logger } from "./logger.js";

const log = logger("env");
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const ACTIVITY_LOG_MODES = ["sync", "batch"] as const;

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
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
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    log.fatal({ errors: formatted }, "Environment validation failed");
    throw new Error(`Environment validation failed: ${JSON.stringify(formatted)}`);
  }

  _env = result.data;
  log.debug({ port: _env.PORT, dbUrl: _env.DATABASE_URL }, "Environment loaded");
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

/**
 * Returns `{ model }` only when no custom base URL is configured.
 * When ANTHROPIC_BASE_URL is set, the proxy decides the model.
 */
export function modelOption(model: string): { model: string } | Record<string, never> {
  return process.env.ANTHROPIC_BASE_URL ? {} : { model };
}

/** Validate env without caching — useful for testing */
export function validateEnv(env: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(env);
}
