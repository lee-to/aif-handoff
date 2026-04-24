import type { Context } from "hono";
import { getEnv, logger } from "@aif/shared";

const log = logger("internal-broadcast-auth");

function extractBearerToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

function isLoopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "127.0.0.1" || first === "::1" || first === "localhost";
}

function resolveBroadcastAuthDecision(c: Context): {
  trusted: boolean;
  mode: "token" | "test_bypass" | "development_loopback" | "rejected";
  tokenConfigured: boolean;
} {
  const configuredToken = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headerToken =
    c.req.header("x-internal-broadcast-token") ?? extractBearerToken(c.req.header("authorization"));

  if (configuredToken) {
    return {
      trusted: headerToken === configuredToken,
      mode: "token",
      tokenConfigured: true,
    };
  }

  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase() ?? "";
  if (nodeEnv === "test") {
    return {
      trusted: true,
      mode: "test_bypass",
      tokenConfigured: false,
    };
  }

  if (nodeEnv === "development") {
    return {
      trusted:
        isLoopbackAddress(c.req.header("x-forwarded-for")) ||
        isLoopbackAddress(c.req.header("x-real-ip")),
      mode: "development_loopback",
      tokenConfigured: false,
    };
  }

  return {
    trusted: false,
    mode: "rejected",
    tokenConfigured: false,
  };
}

export async function internalBroadcastAuth(c: Context, next: () => Promise<void>) {
  const decision = resolveBroadcastAuthDecision(c);
  if (!decision.trusted) {
    log.warn(
      {
        authMode: decision.mode,
        tokenConfigured: decision.tokenConfigured,
        nodeEnv: process.env.NODE_ENV ?? null,
        path: c.req.path,
        forwardedFor: c.req.header("x-forwarded-for") ?? null,
        realIp: c.req.header("x-real-ip") ?? null,
      },
      "Rejected unauthorized internal broadcast request",
    );
    return c.json({ error: "Unauthorized broadcast caller" }, 401);
  }

  await next();
}
