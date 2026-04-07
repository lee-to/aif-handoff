import { logger } from "@aif/shared";

const log = logger("mcp:rate-limit");

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  rpm: number;
  /** Maximum burst size (bucket capacity) */
  burst: number;
}

/**
 * Token bucket rate limiter for MCP tools.
 * Each tool category (read/write) has its own bucket.
 */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly readConfig: RateLimiterConfig;
  private readonly writeConfig: RateLimiterConfig;

  constructor(readConfig: RateLimiterConfig, writeConfig: RateLimiterConfig) {
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
  }

  /**
   * Check if a tool call is allowed. Returns true if allowed, false if rate limited.
   */
  check(toolName: string, category: "read" | "write"): boolean {
    const config = category === "read" ? this.readConfig : this.writeConfig;
    const key = `${category}:${toolName}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / 60_000) * config.rpm;
    bucket.tokens = Math.min(config.burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    log.debug(
      { toolName, category, tokens: bucket.tokens.toFixed(2), burst: config.burst },
      "Token bucket state",
    );

    if (bucket.tokens < 1) {
      log.warn({ toolName, category, tokens: bucket.tokens.toFixed(2) }, "Rate limit hit");
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }
}
