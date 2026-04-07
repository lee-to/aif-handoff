import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { checkRuntimeReadiness } from "@aif/runtime";
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

app.get("/agent/readiness", async (c) => {
  const enabledProfiles = listRuntimeProfiles({ enabledOnly: true });

  try {
    const registry = await getApiRuntimeRegistry();
    const readiness = await checkRuntimeReadiness({
      registry,
      logger: {
        debug(context, message) {
          log.debug({ ...context }, message);
        },
        warn(context, message) {
          log.warn({ ...context }, message);
        },
      },
    });

    return c.json({
      ...readiness,
      enabledRuntimeProfileCount: enabledProfiles.length,
    });
  } catch (error) {
    log.error({ error }, "Failed to build runtime readiness payload");
    return c.json(
      {
        ready: false,
        runtimeCount: 0,
        runtimes: [],
        enabledRuntimeProfileCount: enabledProfiles.length,
        message: "Failed to resolve runtime registry for readiness checks.",
        checkedAt: new Date().toISOString(),
      },
      500,
    );
  }
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
        runtimeReadiness: {
          availableRuntimeCount: registry.listRuntimes().length,
          runtimeProfileCount: runtimeProfiles.length,
          enabledRuntimeProfileCount: enabledProfiles.length,
        },
        runtimeDefaults: {
          modules: env.AIF_RUNTIME_MODULES,
          openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
          agentApiBaseUrlConfigured: Boolean(env.AGENTAPI_BASE_URL),
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
        runtimeReadiness: {
          availableRuntimeCount: 0,
          runtimeProfileCount: allProfiles.length,
          enabledRuntimeProfileCount: enabledProfiles.length,
        },
        runtimeDefaults: {
          modules: env.AIF_RUNTIME_MODULES,
          openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
          agentApiBaseUrlConfigured: Boolean(env.AGENTAPI_BASE_URL),
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

const server = serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, "API server started");
});

// Inject WebSocket into the running server
injectWebSocket(server);
log.debug("WebSocket injected into server");

export { app };
