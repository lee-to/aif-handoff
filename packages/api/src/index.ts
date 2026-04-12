import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger, getEnv } from "@aif/shared";
import { listProjects, listRuntimeProfiles, listStaleInProgressTasks } from "@aif/data";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { chatRouter } from "./routes/chat.js";
import { settingsRoutes } from "./routes/settings.js";
import { runtimeProfilesRouter } from "./routes/runtimeProfiles.js";
import { setupWebSocket } from "./ws.js";
import { requestLogger } from "./middleware/logger.js";
import { getApiRuntimeRegistry } from "./services/runtime.js";
import { startServer } from "./serverBootstrap.js";

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
app.get("/settings", (c) => {
  const env = getEnv();
  return getApiRuntimeRegistry()
    .then((registry) => {
      const runtimeProfiles = listRuntimeProfiles();
      const enabledProfiles = runtimeProfiles.filter((profile) => profile.enabled);
      return c.json({
        useSubagents: env.AGENT_USE_SUBAGENTS,
        maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
        autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
        runtimeReadiness: {
          availableRuntimeCount: registry.listRuntimes().length,
          runtimeProfileCount: runtimeProfiles.length,
          enabledRuntimeProfileCount: enabledProfiles.length,
        },
        runtimeDefaults: {
          modules: env.AIF_RUNTIME_MODULES,
          openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
          codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        },
      });
    })
    .catch((error) => {
      log.error({ error }, "Failed to include runtime settings payload");
      const allProfiles = listRuntimeProfiles();
      const enabledProfiles = listRuntimeProfiles({ enabledOnly: true });
      return c.json({
        useSubagents: env.AGENT_USE_SUBAGENTS,
        maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
        autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
        runtimeReadiness: {
          availableRuntimeCount: 0,
          runtimeProfileCount: allProfiles.length,
          enabledRuntimeProfileCount: enabledProfiles.length,
        },
        runtimeDefaults: {
          modules: env.AIF_RUNTIME_MODULES,
          openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
          codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        },
      });
    });
});

// Routes
app.route("/projects", projectsRouter);
app.route("/tasks", tasksRouter);
app.route("/chat", chatRouter);
app.route("/settings", settingsRoutes);
app.route("/runtime-profiles", runtimeProfilesRouter);

// Initialize DB and start server
const port = Number(process.env.PORT) || 3009;

// Ensure data layer / DB is ready
listProjects();

const server = startServer({
  fetch: app.fetch,
  port,
  injectWebSocket,
  logger: log,
});

export { app, server };
