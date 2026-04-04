import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { logger, getEnv } from "@aif/shared";
import { listProjects, listRuntimeProfiles, listStaleInProgressTasks } from "@aif/data";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

function detectClaudeAuthProfile(): { hasClaudeAuth: boolean; detectedPath: string | null } {
  const home = homedir();
  const candidateFiles = [
    join(home, ".claude.json"),
    join(home, ".claude", "auth.json"),
    join(home, ".claude", "credentials.json"),
    join(home, ".config", "claude", "auth.json"),
    join(home, ".config", "claude", "credentials.json"),
  ];

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) {
      return { hasClaudeAuth: true, detectedPath: filePath };
    }
  }

  const candidateDirs = [join(home, ".claude"), join(home, ".config", "claude")];

  for (const dirPath of candidateDirs) {
    if (!existsSync(dirPath)) continue;
    try {
      const hasAnyJson = readdirSync(dirPath, { withFileTypes: true }).some(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"),
      );
      if (hasAnyJson) {
        return { hasClaudeAuth: true, detectedPath: dirPath };
      }
    } catch {
      // Ignore unreadable directories; readiness stays false unless another source is found.
    }
  }

  return { hasClaudeAuth: false, detectedPath: null };
}

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.get("/agent/readiness", (c) => {
  const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const hasOpenAiApiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasApiKey = hasAnthropicApiKey || hasOpenAiApiKey;
  const { hasClaudeAuth, detectedPath } = detectClaudeAuthProfile();
  const enabledProfiles = listRuntimeProfiles({ enabledOnly: true });

  return getApiRuntimeRegistry()
    .then((registry) => {
      const runtimes = registry.listRuntimes();
      const ready =
        runtimes.length > 0 &&
        (enabledProfiles.length > 0 ||
          hasApiKey ||
          hasClaudeAuth ||
          Boolean(process.env.CODEX_CLI_PATH));
      const authSource = hasApiKey
        ? hasClaudeAuth
          ? "both"
          : "api_key"
        : hasClaudeAuth
          ? "profile"
          : "none";

      return c.json({
        ready,
        hasApiKey,
        hasAnthropicApiKey,
        hasOpenAiApiKey,
        hasClaudeAuth,
        authSource,
        detectedPath,
        runtimeCount: runtimes.length,
        enabledRuntimeProfileCount: enabledProfiles.length,
        runtimes: runtimes.map((runtime) => ({
          id: runtime.id,
          providerId: runtime.providerId,
          displayName: runtime.displayName,
          capabilities: runtime.capabilities,
        })),
        message: ready
          ? "Runtime execution prerequisites are configured."
          : "No usable runtime profile/auth is configured. Add a runtime profile or set provider credentials in environment variables.",
        checkedAt: new Date().toISOString(),
      });
    })
    .catch((error) => {
      log.error({ error }, "Failed to build runtime readiness payload");
      return c.json(
        {
          ready: false,
          hasApiKey,
          hasAnthropicApiKey,
          hasOpenAiApiKey,
          hasClaudeAuth,
          authSource: "none",
          detectedPath,
          runtimeCount: 0,
          enabledRuntimeProfileCount: enabledProfiles.length,
          runtimes: [],
          message: "Failed to resolve runtime registry for readiness checks.",
          checkedAt: new Date().toISOString(),
        },
        500,
      );
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
