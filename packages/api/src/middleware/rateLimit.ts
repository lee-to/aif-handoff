import type { MiddlewareHandler } from "hono";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
}): MiddlewareHandler {
  const { windowMs, maxRequests } = options;
  const clients = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (entry.resetAt <= now) clients.delete(key);
    }
  }, windowMs).unref();

  return async (c, next) => {
    const clientIp =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const now = Date.now();
    const entry = clients.get(clientIp);

    if (!entry || entry.resetAt <= now) {
      clients.set(clientIp, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      return c.json({ error: "Too many requests, please try again later" }, 429);
    }

    await next();
  };
}
