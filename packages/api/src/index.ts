import { Hono } from "hono";
import { cors } from "hono/cors";
import { getEnv, logger } from "@aif/shared";
import { listProjects, listStaleInProgressTasks } from "@aif/data";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { chatRouter } from "./routes/chat.js";
import { buildSettingsOverview, settingsRoutes } from "./routes/settings.js";
import { runtimeProfilesRouter } from "./routes/runtimeProfiles.js";
import { codexAuthRouter } from "./routes/codexAuth.js";
import { setupWebSocket, closeAllWebSocketClients } from "./ws.js";
import { requestLogger } from "./middleware/logger.js";
import { trackApiLoad } from "./middleware/apiLoad.js";
import { startServer } from "./serverBootstrap.js";
import { createCodexIndexService } from "./services/codexIndex.js";
import { createGracefulShutdownHandler } from "./shutdown.js";

const log = logger("server");
const startTime = Date.now();

const app = new Hono();

// WebSocket must be set up before routes
const { injectWebSocket } = setupWebSocket(app);

// Middleware
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5180",
  }),
);
app.use("*", trackApiLoad);
app.use("*", requestLogger);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Agent status: running tasks, heartbeat lag, uptime
app.get("/agent/status", (c) => {
  const now = Date.now();
  const activeTasks = listStaleInProgressTasks().map((t) => {
    const heartbeatAt = t.lastHeartbeatAt ? new Date(t.lastHeartbeatAt).getTime() : null;
    const updatedAt = t.updatedAt ? new Date(t.updatedAt).getTime() : now;
    const lagMs = heartbeatAt ? now - heartbeatAt : now - updatedAt;

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      lastHeartbeatAt: t.lastHeartbeatAt,
      heartbeatLagMs: lagMs,
      heartbeatStale: lagMs > 5 * 60 * 1000, // > 5 min without heartbeat
      updatedAt: t.updatedAt,
    };
  });

  return c.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeTasks,
    activeTaskCount: activeTasks.length,
    staleTasks: activeTasks.filter((t) => t.heartbeatStale).length,
    checkedAt: new Date().toISOString(),
  });
});

// Settings (expose env defaults to frontend)
app.get("/settings", async (c) => {
  return c.json(await buildSettingsOverview());
});

// Routes
app.route("/projects", projectsRouter);
app.route("/tasks", tasksRouter);
app.route("/chat", chatRouter);
app.route("/settings", settingsRoutes);
app.route("/runtime-profiles", runtimeProfilesRouter);

// Codex OAuth login proxy (feature-flagged; see AIF_ENABLE_CODEX_LOGIN_PROXY).
// The /auth/codex/capabilities endpoint is always registered so the frontend can
// discover whether the feature is available; the mutating endpoints register only
// when the flag is true.
if (getEnv().AIF_ENABLE_CODEX_LOGIN_PROXY) {
  log.info("Codex login proxy enabled - mounting /auth/codex routes");
  app.route("/auth/codex", codexAuthRouter);
} else {
  log.debug("Codex login proxy disabled - mounting capabilities endpoint only");
  const disabledRouter = new Hono();
  disabledRouter.get("/capabilities", (c) =>
    c.json({ loginProxyEnabled: false, loopbackPort: getEnv().AIF_CODEX_LOGIN_LOOPBACK_PORT }),
  );
  app.route("/auth/codex", disabledRouter);
}

// Initialize DB and start server
const port = Number(process.env.PORT) || 3009;

// Ensure data layer / DB is ready
listProjects();
const codexIndexService = createCodexIndexService();

const server = startServer({
  fetch: app.fetch,
  port,
  injectWebSocket,
  onStarted() {
    void codexIndexService.start();
  },
  logger: log,
});

// ---------------------------------------------------------------------------
// Graceful shutdown: stop the Codex indexer, close HTTP server, and terminate
// WS clients so Ctrl+C / tsx-watch reload frees port 3009 without a second
// signal. Without this the open WS connections keep the event loop alive and
// the next restart hits EADDRINUSE.
// ---------------------------------------------------------------------------
const onShutdown = createGracefulShutdownHandler({
  logger: log,
  stopCodexIndex: () => codexIndexService.stop(),
  closeWebSockets: closeAllWebSocketClients,
  closeServer: () => {
    server.close();
  },
  exitProcess: (code) => {
    process.exit(code);
  },
});

process.on("SIGINT", () => {
  void onShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void onShutdown("SIGTERM");
});

export { app, server };
