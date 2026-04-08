/**
 * Event-driven wake channel — subscribes to API WebSocket for coordinator wake signals.
 * Extracted from notifier.ts for single responsibility.
 */

import { logger, getEnv } from "@aif/shared";

const log = logger("wake-channel");

/** Events that should trigger a coordinator wake. */
const WAKE_EVENTS = new Set(["task:created", "task:moved", "agent:wake"]);

type WakeCallback = (reason: string) => void;

let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _wakeCallback: WakeCallback | null = null;
let _lastWakeTime = 0;
let _reconnectAttempts = 0;
let _closed = false;

const DEBOUNCE_MS = 2000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const READINESS_PROBE_TIMEOUT_MS = 3000;
const READINESS_MAX_RETRIES = 10;
const READINESS_RETRY_DELAY_MS = 2000;

function getWsUrl(): string {
  const env = getEnv();
  const httpBase = env.API_BASE_URL;
  return httpBase.replace(/^http/, "ws") + "/ws";
}

function getApiBaseUrl(): string {
  return getEnv().API_BASE_URL;
}

/** Probe the API health endpoint to confirm it's accepting connections. */
export async function waitForApiReady(): Promise<boolean> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/health`;

  for (let attempt = 1; attempt <= READINESS_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        log.info({ attempt }, "API health endpoint responded");
        return true;
      }
      log.debug({ attempt, status: res.status }, "API not ready yet");
    } catch {
      log.debug({ attempt }, "API readiness probe failed — retrying");
    }

    if (attempt < READINESS_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, READINESS_RETRY_DELAY_MS));
    }
  }

  log.warn("API readiness probe exhausted retries — proceeding with WS connect anyway");
  return false;
}

function handleMessage(data: string): void {
  try {
    const parsed = JSON.parse(data);
    const eventType = parsed?.type as string | undefined;

    if (!eventType || !WAKE_EVENTS.has(eventType)) return;

    const now = Date.now();
    if (now - _lastWakeTime < DEBOUNCE_MS) {
      log.debug({ eventType, debounceMs: DEBOUNCE_MS }, "Wake debounced");
      return;
    }

    _lastWakeTime = now;
    log.info({ reason: eventType }, "Wake signal received");
    _wakeCallback?.(eventType);
  } catch {
    log.debug("Failed to parse WS message for wake channel");
  }
}

/** Calculate reconnect delay with exponential backoff + jitter. */
export function getReconnectDelay(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * exponential * 0.3);
  return exponential + jitter;
}

function scheduleReconnect(): void {
  if (_reconnectTimer || _closed) return;
  if (!_wakeCallback) {
    log.debug("No wake callback registered — skipping reconnect");
    return;
  }

  const delay = getReconnectDelay(_reconnectAttempts);
  log.info(
    { attempt: _reconnectAttempts + 1, delayMs: delay },
    "Scheduling wake channel reconnect",
  );

  const callback = _wakeCallback;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectAttempts++;
    connectWakeChannel(callback);
  }, delay);
  if (typeof _reconnectTimer === "object" && "unref" in _reconnectTimer) {
    _reconnectTimer.unref();
  }
}

/**
 * Connect to the API WebSocket to receive wake signals.
 * Returns true if the connection was initiated (not necessarily open yet).
 */
export function connectWakeChannel(onWake: WakeCallback): boolean {
  _wakeCallback = onWake;
  _closed = false;
  const wsUrl = getWsUrl();

  try {
    _ws = new WebSocket(wsUrl);

    _ws.addEventListener("open", () => {
      _reconnectAttempts = 0;
      log.info({ wsUrl }, "Wake channel connected");
    });

    _ws.addEventListener("message", (event) => {
      handleMessage(typeof event.data === "string" ? event.data : String(event.data));
    });

    _ws.addEventListener("close", () => {
      log.warn("Wake channel disconnected — scheduling reconnect");
      _ws = null;
      scheduleReconnect();
    });

    _ws.addEventListener("error", (err) => {
      log.error({ err }, "Wake channel error");
    });

    return true;
  } catch (err) {
    log.error({ err, wsUrl }, "Failed to initiate wake channel connection");
    scheduleReconnect();
    return false;
  }
}

/** Close the wake channel cleanly. */
export function closeWakeChannel(): void {
  _closed = true;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _wakeCallback = null;
  _reconnectAttempts = 0;
  log.debug("Wake channel closed");
}

/** Returns true if the wake WS is currently connected (OPEN). */
export function isWakeChannelConnected(): boolean {
  return _ws?.readyState === WebSocket.OPEN;
}

/** Reset internal state — for testing only. */
export function _resetForTesting(): void {
  _ws = null;
  _reconnectTimer = null;
  _wakeCallback = null;
  _lastWakeTime = 0;
  _reconnectAttempts = 0;
  _closed = false;
}
