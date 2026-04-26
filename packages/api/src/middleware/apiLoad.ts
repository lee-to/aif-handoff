import type { MiddlewareHandler } from "hono";

let activeRequests = 0;
let lastRequestFinishedAt = 0;

export const trackApiLoad: MiddlewareHandler = async (_c, next) => {
  activeRequests += 1;
  try {
    await next();
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    lastRequestFinishedAt = Date.now();
  }
};

export function isApiIdle(minIdleMs = 1000): boolean {
  return activeRequests === 0 && Date.now() - lastRequestFinishedAt >= minIdleMs;
}

export function readApiLoadState(): {
  activeRequests: number;
  lastRequestFinishedAt: number;
} {
  return {
    activeRequests,
    lastRequestFinishedAt,
  };
}
