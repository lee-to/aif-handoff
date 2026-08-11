import { timingSafeEqual } from "node:crypto";
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

function tokensMatch(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return (
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

function resolveBroadcastAuthDecision(c: Context): {
  trusted: boolean;
  mode: "token" | "test_bypass" | "rejected";
  tokenConfigured: boolean;
} {
  const configuredToken = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headerToken =
    c.req.header("x-internal-broadcast-token") ?? extractBearerToken(c.req.header("authorization"));

  if (configuredToken) {
    return {
      trusted: tokensMatch(headerToken, configuredToken),
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
      },
      "Rejected unauthorized internal broadcast request",
    );
    return c.json({ error: "Unauthorized broadcast caller" }, 401);
  }

  log.debug({ authMode: decision.mode, path: c.req.path }, "Authorized internal broadcast request");
  await next();
}
