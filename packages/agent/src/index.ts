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
    loopbackPort: env.AIF_CODEX_LOGIN_LOOPBACK_PORT,
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
