import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { logger } from "@aif/shared";

const log = logger("codex-login-broker");

const DEFAULT_PORT = 3010;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_LOOPBACK_PORT = 1455;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const CHILD_EXIT_TIMEOUT_MS = 30 * 1000;

const AUTH_URL_PATTERN = /https:\/\/[^\s]+(?:auth|authorize|login)[^\s]*/i;

const callbackBodySchema = z.object({
  url: z.string().min(1, "url is required").max(4096),
});

export interface LoginSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  authUrl: string;
  state: string | null;
  startedAt: number;
  timeoutHandle: NodeJS.Timeout;
}

export interface BrokerRuntime {
  app: Hono;
  /** Internal accessor for tests */
  getCurrentSession(): LoginSession | null;
}

export interface BrokerServer {
  runtime: BrokerRuntime;
  server: ServerType;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface BrokerOptions {
  port?: number;
  host?: string;
  loopbackHost?: string;
  loopbackPort?: number;
  codexCliPath?: string;
  /** Override spawn for tests */
  spawnFn?: typeof spawn;
  /** Override fetch for tests */
  fetchFn?: typeof fetch;
}

interface BrokerContext {
  currentSession: LoginSession | null;
  options: Required<Omit<BrokerOptions, "spawnFn" | "fetchFn">> & {
    spawnFn: typeof spawn;
    fetchFn: typeof fetch;
  };
}

/**
 * Extract the auth URL that the codex CLI prints to stdout. Codex currently
 * prints a line like `Visit https://chatgpt.com/auth/authorize?...` or
 * similar. Kept forgiving — we just need the first https URL that contains
 * an auth-like path segment.
 */
export function extractAuthUrlFromStdout(chunk: string): string | null {
  const match = AUTH_URL_PATTERN.exec(chunk);
  return match ? match[0] : null;
}

/**
 * Parse the `state` query parameter from the auth URL, used to match the
 * callback. Returns null when the URL has no state parameter or cannot be
 * parsed.
 */
export function extractStateFromAuthUrl(authUrl: string): string | null {
  try {
    const parsed = new URL(authUrl);
    return parsed.searchParams.get("state");
  } catch {
    return null;
  }
}

export interface CallbackValidationResult {
  ok: boolean;
  reason?: string;
  parsed?: URL;
}

/**
 * Validate that a user-pasted callback URL is safe to proxy to the codex
 * loopback listener. Allows only the expected host/port/scheme and requires
 * both `code` and `state` to be present.
 */
export function validateCallbackUrl(
  rawUrl: string,
  options: { loopbackHost: string; loopbackPort: number; expectedState: string | null },
): CallbackValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:") {
    return { ok: false, reason: "scheme_not_allowed" };
  }

  const allowedHosts = new Set<string>([options.loopbackHost, "localhost", "127.0.0.1"]);
  if (!allowedHosts.has(parsed.hostname)) {
    return { ok: false, reason: "host_not_allowed" };
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isFinite(port) || port !== options.loopbackPort) {
    return { ok: false, reason: "port_not_allowed" };
  }

  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  if (!code) return { ok: false, reason: "missing_code" };
  if (!state) return { ok: false, reason: "missing_state" };

  if (options.expectedState !== null && state !== options.expectedState) {
    return { ok: false, reason: "state_mismatch" };
  }

  return { ok: true, parsed };
}

/** Mask sensitive query parameters in a URL for logging. */
export function redactCallbackUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of ["code", "state", "id_token", "access_token"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "***redacted***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable-url>";
  }
}

function terminateSession(ctx: BrokerContext, reason: string): void {
  const session = ctx.currentSession;
  if (!session) return;
  log.info({ sessionId: session.id, reason }, "[Broker.terminateSession] ending session");
  clearTimeout(session.timeoutHandle);
  if (!session.child.killed) {
    try {
      session.child.kill("SIGTERM");
    } catch (err) {
      log.warn({ err }, "[Broker.terminateSession] failed to kill child");
    }
  }
  ctx.currentSession = null;
}

function createBrokerApp(ctx: BrokerContext): Hono {
  const app = new Hono();

  app.get("/codex/login/status", (c) => {
    log.debug("[Broker.status] enter");
    const session = ctx.currentSession;
    if (!session) return c.json({ active: false });
    return c.json({
      active: true,
      sessionId: session.id,
      authUrl: session.authUrl,
      startedAt: new Date(session.startedAt).toISOString(),
    });
  });

  app.post("/codex/login/start", async (c) => {
    log.debug("[Broker.start] enter");

    if (ctx.currentSession) {
      log.warn(
        { sessionId: ctx.currentSession.id },
        "[Broker.start] rejected — session already active",
      );
      return c.json(
        {
          error: "session_already_active",
          sessionId: ctx.currentSession.id,
          authUrl: ctx.currentSession.authUrl,
        },
        409,
      );
    }

    const cliPath = ctx.options.codexCliPath;
    log.debug({ cliPath }, "[Broker.start] spawning codex login");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = ctx.options.spawnFn(cliPath, ["login"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      log.error({ err }, "[Broker.start] spawn failed");
      return c.json({ error: "spawn_failed", message: String(err) }, 500);
    }

    const sessionId = randomUUID();
    const startedAt = Date.now();

    const urlPromise = new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffered = "";

      const onData = (data: Buffer) => {
        const text = data.toString("utf8");
        buffered += text;
        log.debug({ chunk: text.slice(0, 200) }, "[Broker.start] codex stdout");
        const url = extractAuthUrlFromStdout(buffered);
        if (url && !settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          resolve(url);
        }
      };
      const onStderr = (data: Buffer) => {
        const text = data.toString("utf8");
        log.debug({ chunk: text.slice(0, 200) }, "[Broker.start] codex stderr");
        buffered += text;
        const url = extractAuthUrlFromStdout(buffered);
        if (url && !settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          resolve(url);
        }
      };
      const onExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          reject(new Error(`codex exited before printing auth URL (code=${code})`));
        }
      };
      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
      child.once("exit", onExit);
      child.once("error", onError);

      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          reject(new Error("timed out waiting for codex auth URL"));
        }
      }, 15_000).unref();
    });

    let authUrl: string;
    try {
      authUrl = await urlPromise;
    } catch (err) {
      log.error({ err }, "[Broker.start] failed to extract auth URL");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      return c.json({ error: "auth_url_parse_failed", message: String(err) }, 500);
    }

    const state = extractStateFromAuthUrl(authUrl);

    const timeoutHandle = setTimeout(() => {
      log.warn({ sessionId }, "[Broker.start] session timed out");
      terminateSession(ctx, "timeout");
    }, SESSION_TIMEOUT_MS);
    timeoutHandle.unref();

    const session: LoginSession = {
      id: sessionId,
      child,
      authUrl,
      state,
      startedAt,
      timeoutHandle,
    };

    child.once("exit", (code, signal) => {
      log.info({ sessionId, code, signal }, "[Broker.childExit] codex exited");
      if (ctx.currentSession?.id === sessionId) {
        clearTimeout(session.timeoutHandle);
        ctx.currentSession = null;
      }
    });

    ctx.currentSession = session;
    log.info({ sessionId, hasState: state !== null }, "[Broker.start] session started");
    return c.json({ sessionId, authUrl, startedAt: new Date(startedAt).toISOString() });
  });

  app.post("/codex/login/callback", async (c) => {
    log.debug("[Broker.callback] enter");
    const session = ctx.currentSession;
    if (!session) {
      log.warn("[Broker.callback] no active session");
      return c.json({ error: "no_active_session" }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parsed = callbackBodySchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, "[Broker.callback] body validation failed");
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    const validation = validateCallbackUrl(parsed.data.url, {
      loopbackHost: ctx.options.loopbackHost,
      loopbackPort: ctx.options.loopbackPort,
      expectedState: session.state,
    });

    if (!validation.ok || !validation.parsed) {
      log.warn(
        { reason: validation.reason, url: redactCallbackUrl(parsed.data.url) },
        "[Broker.callback] URL validation failed",
      );
      return c.json({ error: "invalid_callback_url", reason: validation.reason }, 400);
    }

    const target = validation.parsed.toString();
    log.info(
      { sessionId: session.id, target: redactCallbackUrl(target) },
      "[Broker.callback] proxying callback to codex loopback",
    );

    let proxyResponse: Response;
    try {
      proxyResponse = await ctx.options.fetchFn(target, { method: "GET" });
    } catch (err) {
      log.error({ err }, "[Broker.callback] fetch to loopback failed");
      return c.json({ error: "loopback_fetch_failed", message: String(err) }, 502);
    }

    if (!proxyResponse.ok) {
      log.warn(
        { status: proxyResponse.status },
        "[Broker.callback] loopback returned non-2xx — keeping child alive",
      );
      return c.json({ error: "loopback_non_2xx", status: proxyResponse.status }, 502);
    }

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        if (session.child.exitCode !== null) {
          resolve({ code: session.child.exitCode, signal: null });
          return;
        }
        session.child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    const timeoutPromise = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), CHILD_EXIT_TIMEOUT_MS);
      t.unref();
    });

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result === null) {
      log.warn({ sessionId: session.id }, "[Broker.callback] child did not exit within timeout");
      return c.json({ error: "child_exit_timeout" }, 504);
    }

    log.info(
      { sessionId: session.id, code: result.code, signal: result.signal },
      "[Broker.callback] login completed successfully",
    );
    clearTimeout(session.timeoutHandle);
    ctx.currentSession = null;
    return c.json({ ok: true, exitCode: result.code });
  });

  app.post("/codex/login/cancel", (c) => {
    log.debug("[Broker.cancel] enter");
    const session = ctx.currentSession;
    if (!session) return c.json({ ok: true, cancelled: false });
    terminateSession(ctx, "cancel");
    return c.json({ ok: true, cancelled: true, sessionId: session.id });
  });

  return app;
}

export function createBrokerRuntime(options: BrokerOptions = {}): BrokerRuntime {
  const ctx: BrokerContext = {
    currentSession: null,
    options: {
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? DEFAULT_HOST,
      loopbackHost: options.loopbackHost ?? DEFAULT_LOOPBACK_HOST,
      loopbackPort: options.loopbackPort ?? DEFAULT_LOOPBACK_PORT,
      codexCliPath: options.codexCliPath ?? "codex",
      spawnFn: options.spawnFn ?? spawn,
      fetchFn: options.fetchFn ?? fetch,
    },
  };

  const app = createBrokerApp(ctx);
  return {
    app,
    getCurrentSession: () => ctx.currentSession,
  };
}

export async function startLoginBroker(options: BrokerOptions = {}): Promise<BrokerServer> {
  const runtime = createBrokerRuntime(options);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const server = serve({ fetch: runtime.app.fetch, port, hostname: host });
  log.info({ host, port }, "[CodexLoginBroker] listening");

  return {
    runtime,
    server,
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
