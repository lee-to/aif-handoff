import { createRequire } from "node:module";
import { createDbUsageSink, listProjects } from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { bootstrapRuntimeRegistry } from "@aif/runtime";
import { pollAndProcess, setRuntimeRegistry } from "./coordinator.js";
import { flushAllActivityQueues } from "./hooks.js";
import { notifyProjectRuntimeLimitBroadcast } from "./notifier.js";
import { connectWakeChannel, closeWakeChannel, waitForApiReady } from "./wakeChannel.js";
import { abortAllActiveStages } from "./stageAbort.js";
import { startPollScheduler } from "./pollScheduler.js";
import { startLoginBroker, type BrokerServer } from "./codex/loginBroker.js";

const log = logger("agent");

// `ai-factory` is a hard runtime dependency: the runtime layer invokes its
// CLI to scaffold `.ai-factory/` for every new project (see
// `@aif/runtime/projectInit`). If it is missing locally, the runtime falls
// back to `npx ai-factory ...`, which requires network access and a registry
// hit at task-run time — fragile in air-gapped or production deploys
// installed with `npm ci --omit=dev`. Probe at boot and warn loudly so the
// failure is diagnosable from the first agent log line, not buried under a
// later "skipped task" warning.
function probeAiFactory(): void {
  const localRequire = createRequire(import.meta.url);
  try {
    localRequire.resolve("ai-factory/bin/ai-factory.js");
  } catch {
    log.warn(
      "ai-factory CLI is not installed locally. The agent will fall back to " +
        "`npx ai-factory ...` for project scaffolding, which requires network " +
        "access. Add `ai-factory` to dependencies (not devDependencies) and " +
        "reinstall to make this offline-safe.",
    );
  }
}
probeAiFactory();

// Validate env
const env = getEnv();

// Ensure DB is ready
listProjects();

const pollScheduler = startPollScheduler(async () => {
  try {
    await pollAndProcess();
  } catch (err) {
    log.error({ err }, "Unexpected error in poll cycle");
  }
}, env.POLL_INTERVAL_MS);

// Pre-load runtime registry so project init includes all adapters
bootstrapRuntimeRegistry({
  runtimeModules: env.AIF_RUNTIME_MODULES,
  modelEffortDiscoveryEnabled: env.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED,
  usageSink: createDbUsageSink({
    onRecorded: (event) => {
      if (!event.context.projectId || !event.profileId) return;
      void notifyProjectRuntimeLimitBroadcast(event.context.projectId, event.profileId, {
        taskId: event.context.taskId ?? null,
      });
    },
  }),
})
  .then((registry) => {
    setRuntimeRegistry(registry);
    log.info("Runtime registry loaded for project initialization");
  })
  .catch((err) => log.warn({ err }, "Failed to pre-load runtime registry"));

log.info(
  {
    configuredIntervalMs: env.POLL_INTERVAL_MS,
    intervalMs: pollScheduler.intervalMs,
  },
  "Agent coordinator starting",
);

// ---------------------------------------------------------------------------
// Event-driven wake: subscribe to API WS for immediate coordinator triggers
// ---------------------------------------------------------------------------
async function triggerWake(reason: string): Promise<void> {
  log.info({ reason }, "Wake-triggered poll cycle starting");
  try {
    await pollAndProcess();
  } catch (err) {
    log.error({ err, reason }, "Unexpected error in wake-triggered poll cycle");
  }
}

if (env.AGENT_WAKE_ENABLED) {
  log.info("Wake transport enabled — probing API readiness before connecting WebSocket");
  void waitForApiReady().then(() => {
    const initiated = connectWakeChannel((reason) => {
      void triggerWake(reason);
    });
    if (!initiated) {
      log.warn("Wake channel connection could not be initiated — falling back to polling only");
    }
  });
} else {
  log.info("Wake transport disabled (AGENT_WAKE_ENABLED=false) — using polling only");
}

// ---------------------------------------------------------------------------
// Codex login broker (feature-flagged)
// ---------------------------------------------------------------------------
let codexLoginBroker: BrokerServer | null = null;
if (env.AIF_ENABLE_CODEX_LOGIN_PROXY) {
  log.info(
    { port: env.AIF_CODEX_LOGIN_BROKER_PORT },
    "AIF_ENABLE_CODEX_LOGIN_PROXY=true — starting codex login broker",
  );
  startLoginBroker({
    port: env.AIF_CODEX_LOGIN_BROKER_PORT,
    codexCliPath: env.CODEX_CLI_PATH ?? "codex",
  })
    .then((broker) => {
      codexLoginBroker = broker;
      log.info(
        { host: broker.host, port: broker.port },
        "[CodexLoginBroker] listening on 0.0.0.0:${port}",
      );
    })
    .catch((err) => {
      log.error({ err }, "[CodexLoginBroker] failed to start");
    });
} else {
  log.debug("AIF_ENABLE_CODEX_LOGIN_PROXY=false — codex login broker disabled");
}

log.info("Agent coordinator is running. Press Ctrl+C to stop.");

// ---------------------------------------------------------------------------
// Graceful shutdown: flush buffered activity logs before exit
// ---------------------------------------------------------------------------
function onShutdown(signal: string): void {
  log.info(
    { signal },
    "Shutdown signal received — aborting stages, closing wake channel, flushing activity queues",
  );
  try {
    pollScheduler.stop();
    abortAllActiveStages();
    closeWakeChannel();
    flushAllActivityQueues();
    if (codexLoginBroker) {
      const active = codexLoginBroker.runtime.getCurrentSession();
      if (active && !active.child.killed) {
        log.info({ sessionId: active.id }, "[CodexLoginBroker] killing active login session");
        try {
          active.child.kill("SIGTERM");
        } catch (err) {
          log.warn({ err }, "[CodexLoginBroker] failed to kill child on shutdown");
        }
      }
      void codexLoginBroker.close();
    }
    log.info("Shutdown flush complete");
  } catch (err) {
    log.error({ err }, "Error during shutdown flush");
  }
  process.exit(0);
}

process.on("SIGINT", () => onShutdown("SIGINT"));
process.on("SIGTERM", () => onShutdown("SIGTERM"));

// Best-effort flush on normal exit (e.g. uncaught exception after handler)
process.on("beforeExit", () => {
  log.debug("beforeExit — flushing remaining activity queues");
  flushAllActivityQueues();
});
