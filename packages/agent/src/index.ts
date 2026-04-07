import cron from "node-cron";
import { listProjects } from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { bootstrapRuntimeRegistry } from "@aif/runtime";
import { pollAndProcess, setRuntimeRegistry } from "./coordinator.js";
import { flushAllActivityQueues } from "./hooks.js";
import { connectWakeChannel, closeWakeChannel, waitForApiReady } from "./wakeChannel.js";
import { abortAllActiveStages } from "./stageAbort.js";

const log = logger("agent");

// Validate env
const env = getEnv();

// Ensure DB is ready
listProjects();

const intervalMs = env.POLL_INTERVAL_MS;
const intervalSeconds = Math.max(Math.floor(intervalMs / 1000), 10);

// Convert to cron expression (every N seconds)
const cronExpr = `*/${intervalSeconds} * * * * *`;

// Pre-load runtime registry so project init includes all adapters
bootstrapRuntimeRegistry({ runtimeModules: env.AIF_RUNTIME_MODULES })
  .then((registry) => {
    setRuntimeRegistry(registry);
    log.info("Runtime registry loaded for project initialization");
  })
  .catch((err) => log.warn({ err }, "Failed to pre-load runtime registry"));

log.info({ intervalMs, intervalSeconds, cronExpr }, "Agent coordinator starting");

cron.schedule(cronExpr, async () => {
  try {
    await pollAndProcess();
  } catch (err) {
    log.error({ err }, "Unexpected error in poll cycle");
  }
});

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
    abortAllActiveStages();
    closeWakeChannel();
    flushAllActivityQueues();
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
