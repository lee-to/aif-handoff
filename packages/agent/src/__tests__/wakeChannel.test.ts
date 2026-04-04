import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @aif/shared before imports
vi.mock("@aif/shared", () => ({
  logger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getEnv: () => ({
    API_BASE_URL: "http://localhost:3009",
  }),
}));

import {
  connectWakeChannel,
  closeWakeChannel,
  isWakeChannelConnected,
  waitForApiReady,
  getReconnectDelay,
  _resetForTesting,
} from "../wakeChannel.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------
type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private listeners: Record<string, WsListener[]> = {};

  addEventListener(event: string, fn: WsListener): void {
    (this.listeners[event] ??= []).push(fn);
  }

  removeEventListener(event: string, fn: WsListener): void {
    const list = this.listeners[event];
    if (!list) return;
    this.listeners[event] = list.filter((f) => f !== fn);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  _emit(event: string, data?: unknown): void {
    for (const fn of this.listeners[event] ?? []) fn(data);
  }

  _simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this._emit("open");
  }

  _simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this._emit("close");
  }

  _simulateMessage(data: string): void {
    this._emit("message", { data });
  }
}

let lastCreatedWs: MockWebSocket | null = null;

function setLastCreatedWs(ws: MockWebSocket): void {
  lastCreatedWs = ws;
}

vi.stubGlobal(
  "WebSocket",
  class extends MockWebSocket {
    constructor() {
      super();
      setLastCreatedWs(this); // eslint-friendly: no this-alias
    }
  },
);

// ---------------------------------------------------------------------------
// Mock fetch for waitForApiReady
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
  lastCreatedWs = null;
  fetchMock.mockReset();
});

afterEach(() => {
  closeWakeChannel();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("wakeChannel", () => {
  describe("connectWakeChannel", () => {
    it("creates a WebSocket and returns true", () => {
      const callback = vi.fn();
      const result = connectWakeChannel(callback);

      expect(result).toBe(true);
      expect(lastCreatedWs).not.toBeNull();
    });

    it("resets reconnect attempts on successful open", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      lastCreatedWs!._simulateOpen();

      expect(isWakeChannelConnected()).toBe(true);
    });

    it("invokes callback on wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      lastCreatedWs!._simulateOpen();

      lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:created" }));
      expect(callback).toHaveBeenCalledWith("task:created");
    });

    it("debounces rapid wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      lastCreatedWs!._simulateOpen();

      lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:created" }));
      lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:moved" }));

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("ignores non-wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      lastCreatedWs!._simulateOpen();

      lastCreatedWs!._simulateMessage(JSON.stringify({ type: "heartbeat" }));
      expect(callback).not.toHaveBeenCalled();
    });

    it("ignores malformed messages", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      lastCreatedWs!._simulateOpen();

      lastCreatedWs!._simulateMessage("not json");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("scheduleReconnect", () => {
    it("reconnects on close with exponential backoff", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      const ws1 = lastCreatedWs!;
      ws1._simulateClose();

      // First reconnect: ~1s base
      vi.advanceTimersByTime(1500);
      expect(lastCreatedWs).not.toBe(ws1);
    });

    it("does not reconnect after closeWakeChannel()", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      const ws1 = lastCreatedWs!;

      closeWakeChannel();
      ws1._simulateClose();

      vi.advanceTimersByTime(60000);
      // No new WS created after close
      expect(lastCreatedWs).toBe(ws1);
    });
  });

  describe("closeWakeChannel", () => {
    it("cleans up all state", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      closeWakeChannel();

      expect(isWakeChannelConnected()).toBe(false);
    });
  });

  describe("getReconnectDelay", () => {
    it("returns exponentially increasing delays", () => {
      // With jitter, delay >= base * 2^attempt
      const d0 = getReconnectDelay(0);
      const d1 = getReconnectDelay(1);
      const d2 = getReconnectDelay(2);

      expect(d0).toBeGreaterThanOrEqual(1000);
      expect(d1).toBeGreaterThanOrEqual(2000);
      expect(d2).toBeGreaterThanOrEqual(4000);
    });

    it("caps at RECONNECT_MAX_MS (30s)", () => {
      const d10 = getReconnectDelay(10);
      // max base = 30000, jitter up to 30% = 39000
      expect(d10).toBeLessThanOrEqual(39000);
    });
  });

  describe("waitForApiReady", () => {
    it("resolves true on immediate success", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });
      const result = await waitForApiReady();
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries on fetch failure and succeeds", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });

      const promise = waitForApiReady();
      // Advance past first retry delay
      await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS);
      const result = await promise;

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });

      const promise = waitForApiReady();
      await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS);
      const result = await promise;

      expect(result).toBe(true);
    });

    it("returns false after exhausting retries", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = waitForApiReady();
      // Advance past all retries (10 retries * 2s = 20s)
      for (let i = 0; i < READINESS_MAX_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS + 100);
      }
      const result = await promise;

      expect(result).toBe(false);
    });
  });
});

// Re-export constants for test assertions
const READINESS_RETRY_DELAY_MS = 2000;
const READINESS_MAX_RETRIES = 10;
