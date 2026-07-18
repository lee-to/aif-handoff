import { logger, getEnv, parseMcpPortSetting } from "@aif/shared";

const log = logger("mcp:env");

export interface McpEnv {
  /** API server URL for WebSocket broadcast (from shared env) */
  apiUrl: string;
  /** Transport mode: "stdio" (default) or "http" (for Docker / remote) */
  transport: "stdio" | "http";
  /** HTTP port when transport is "http" */
  httpPort: number;
  /** Rate limit: requests per minute for read tools */
  rateLimitReadRpm: number;
  /** Rate limit: requests per minute for write tools */
  rateLimitWriteRpm: number;
  /** Rate limit: burst size for read tools */
  rateLimitReadBurst: number;
  /** Rate limit: burst size for write tools */
  rateLimitWriteBurst: number;
  /**
   * Opt-in flag for the stateless multi-session HTTP transport. Defaults to
   * `false` (legacy single-session behavior). Set
   * `AIF_MCP_HTTP_MULTI_SESSION_ENABLED` to 1/true/yes/on to let multiple
   * clients (e.g. several Claude Code windows) connect concurrently to the same
   * `/mcp` endpoint. Only relevant when `transport` is `http`.
   */
  httpMultiSession: boolean;
}

const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Parse an opt-in boolean env flag. Defaults to `false` unless the value is one
 * of 1/true/yes/on (case-insensitive) — matches `@aif/shared` env boolean
 * semantics so operators get consistent behavior across packages.
 */
function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  return BOOLEAN_TRUE_VALUES.has(value.trim().toLowerCase());
}

function resolveMcpPort(value: string | undefined, transport: McpEnv["transport"]): number {
  const parsed = parseMcpPortSetting(value);
  if (parsed.status === "unset") {
    return 3100;
  }

  if (parsed.status === "valid") {
    return parsed.port;
  }

  if (transport === "stdio") {
    log.warn(
      {
        transport,
        invalidValue: parsed.value,
        fallbackPort: 3100,
      },
      "Ignoring invalid MCP_PORT because MCP transport is stdio",
    );
    return 3100;
  }

  throw new Error(`Invalid MCP_PORT: ${parsed.value}. Must be an integer between 1 and 65535.`);
}

/**
 * Load MCP-specific environment config.
 * DB connection uses the shared getDb() from @aif/shared/server (same as api/agent).
 * API_BASE_URL comes from the shared env.
 */
export function loadMcpEnv(): McpEnv {
  const sharedEnv = getEnv();

  const transport = (process.env.MCP_TRANSPORT || "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT: ${transport}. Must be "stdio" or "http".`);
  }

  const env: McpEnv = {
    apiUrl: sharedEnv.API_BASE_URL,
    transport,
    httpPort: resolveMcpPort(process.env.MCP_PORT, transport),
    rateLimitReadRpm: parseInt(process.env.MCP_RATE_LIMIT_READ_RPM || "120", 10),
    rateLimitWriteRpm: parseInt(process.env.MCP_RATE_LIMIT_WRITE_RPM || "30", 10),
    rateLimitReadBurst: parseInt(process.env.MCP_RATE_LIMIT_READ_BURST || "10", 10),
    rateLimitWriteBurst: parseInt(process.env.MCP_RATE_LIMIT_WRITE_BURST || "5", 10),
    httpMultiSession: parseBooleanFlag(process.env.AIF_MCP_HTTP_MULTI_SESSION_ENABLED),
  };

  log.info(
    {
      transport: env.transport,
      httpPort: env.httpPort,
      httpMultiSession: env.httpMultiSession,
    },
    "MCP environment loaded",
  );

  return env;
}
