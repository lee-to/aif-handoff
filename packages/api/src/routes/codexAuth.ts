import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";
import { codexCallbackSchema } from "../schemas.js";
import { jsonValidator } from "../middleware/zodValidator.js";

const log = logger("api:codex-auth");

export const codexAuthRouter = new Hono();

function brokerBaseUrl(): string {
  const env = getEnv();
  return env.AGENT_INTERNAL_URL.replace(/\/$/, "");
}

/** Mask sensitive query parameters before logging. */
function redactUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    for (const key of ["code", "state", "id_token", "access_token"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "***redacted***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable>";
  }
}

async function proxy(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const target = `${brokerBaseUrl()}${path}`;
  log.debug({ method, target }, "[CodexAuth.proxy] forwarding");
  try {
    const res = await fetch(target, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data: unknown = await res.json().catch(() => ({}));
    log.debug({ status: res.status, target }, "[CodexAuth.proxy] response");
    return { status: res.status, body: data };
  } catch (err) {
    log.error({ err, target }, "[CodexAuth.proxy] broker unreachable");
    return {
      status: 502,
      body: { error: "broker_unreachable", message: String(err) },
    };
  }
}

codexAuthRouter.get("/login/status", async (c) => {
  log.debug("[CodexAuth.status] enter");
  const { status, body } = await proxy("GET", "/codex/login/status");
  return c.json(body as object, status as 200 | 502);
});

codexAuthRouter.post("/login/start", async (c) => {
  log.debug("[CodexAuth.start] enter");
  const { status, body } = await proxy("POST", "/codex/login/start");
  return c.json(body as object, status as 200 | 409 | 500 | 502);
});

codexAuthRouter.post("/login/callback", jsonValidator(codexCallbackSchema), async (c) => {
  const body = c.req.valid("json");
  log.info(
    { redactedUrl: redactUrl(body.url) },
    "[CodexAuth.callback] validated — forwarding to broker",
  );
  const { status, body: respBody } = await proxy("POST", "/codex/login/callback", body);
  return c.json(respBody as object, status as 200 | 400 | 409 | 502 | 504);
});

codexAuthRouter.post("/login/cancel", async (c) => {
  log.debug("[CodexAuth.cancel] enter");
  const { status, body } = await proxy("POST", "/codex/login/cancel");
  return c.json(body as object, status as 200 | 502);
});

codexAuthRouter.get("/capabilities", (c) => {
  const env = getEnv();
  return c.json({
    loginProxyEnabled: env.AIF_ENABLE_CODEX_LOGIN_PROXY,
    loopbackPort: env.AIF_CODEX_LOGIN_LOOPBACK_PORT,
  });
});
