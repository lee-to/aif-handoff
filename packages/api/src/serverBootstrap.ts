import { createAdaptorServer } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type pino from "pino";

type StartupLogger = Pick<pino.Logger, "debug" | "error" | "info">;
type StartupFetch = Parameters<typeof createAdaptorServer>[0]["fetch"];

interface StartServerOptions {
  fetch: StartupFetch;
  port: number;
  hostname?: string;
  injectWebSocket?: (server: ServerType) => void;
  logger: StartupLogger;
}

type StartupPhase = "before-ready" | "after-ready";

function formatStartupErrorMessage(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") {
    return `[FIX] Failed to start API server: port ${port} is already in use. Stop the existing process or set PORT to a different value.`;
  }

  return "[FIX] Failed to start API server.";
}

export function startServer({
  fetch,
  port,
  hostname,
  injectWebSocket,
  logger,
}: StartServerOptions): ServerType {
  const server = createAdaptorServer({ fetch, hostname });
  let startupPhase: StartupPhase = "before-ready";

  server.on("error", (error: Error) => {
    const startupError = error as NodeJS.ErrnoException;

    if (startupPhase === "before-ready") {
      logger.error(
        { error, hostname, port, startupPhase },
        formatStartupErrorMessage(startupError, port),
      );
      process.exitCode = 1;
      return;
    }

    logger.error({ error, hostname, port, startupPhase }, "[FIX] API server error.");
  });

  if (injectWebSocket) {
    injectWebSocket(server);
    logger.debug({ hostname, port }, "WebSocket injected into server");
  }

  server.listen(port, hostname, () => {
    startupPhase = "after-ready";
    logger.info({ hostname, port }, "API server started");
  });

  return server;
}
