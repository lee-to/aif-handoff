import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { getEnv } from "@aif/shared";

export function participantCors(): MiddlewareHandler {
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return cors({
      origin: process.env.CORS_ORIGIN || "http://localhost:5180",
    });
  }

  const allowedOrigins = new Set(env.PARTICIPANT_ALLOWED_ORIGINS);
  return cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "X-CSRF-Token"],
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}
