import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAdaptorServerMock = vi.fn();

vi.mock("@hono/node-server", () => ({
  createAdaptorServer: createAdaptorServerMock,
}));

class FakeServer extends EventEmitter {
  listen = vi.fn((port: number, hostname: string | undefined, callback: () => void) => {
    callback();
    return this;
  });
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

describe("startServer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("injects WebSocket support before listening and logs successful startup", async () => {
    const server = new FakeServer();
    const logger = createLogger();
    const injectWebSocket = vi.fn();

    createAdaptorServerMock.mockReturnValue(server);

    const { startServer } = await import("../serverBootstrap.js");

    startServer({
      fetch: vi.fn(),
      port: 3009,
      injectWebSocket,
      logger,
    });

    expect(createAdaptorServerMock).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      hostname: undefined,
    });
    expect(injectWebSocket).toHaveBeenCalledWith(server);
    expect(injectWebSocket.mock.invocationCallOrder[0]).toBeLessThan(
      server.listen.mock.invocationCallOrder[0],
    );
    expect(logger.debug).toHaveBeenCalledWith(
      { hostname: undefined, port: 3009 },
      "WebSocket injected into server",
    );
    expect(logger.info).toHaveBeenCalledWith(
      { hostname: undefined, port: 3009 },
      "API server started",
    );
  });

  it("logs an actionable [FIX] message when the port is already in use", async () => {
    const server = new FakeServer();
    const logger = createLogger();
    const error = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });

    server.listen.mockImplementation((_port: number, _hostname: string | undefined) => {
      server.emit("error", error);
      return server;
    });

    createAdaptorServerMock.mockReturnValue(server);

    const { startServer } = await import("../serverBootstrap.js");

    expect(() =>
      startServer({
        fetch: vi.fn(),
        port: 3009,
        injectWebSocket: vi.fn(),
        logger,
      }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      { error, hostname: undefined, port: 3009, startupPhase: "before-ready" },
      "[FIX] Failed to start API server: port 3009 is already in use. Stop the existing process or set PORT to a different value.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("logs runtime server errors after readiness with explicit startup phase", async () => {
    const server = new FakeServer();
    const logger = createLogger();
    const runtimeError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    server.listen.mockImplementation(
      (port: number, hostname: string | undefined, callback: () => void) => {
        callback();
        server.emit("error", runtimeError);
        return server;
      },
    );

    createAdaptorServerMock.mockReturnValue(server);

    const { startServer } = await import("../serverBootstrap.js");

    expect(() =>
      startServer({
        fetch: vi.fn(),
        port: 3009,
        injectWebSocket: vi.fn(),
        logger,
      }),
    ).not.toThrow();

    expect(logger.info).toHaveBeenCalledWith(
      { hostname: undefined, port: 3009 },
      "API server started",
    );
    expect(logger.error).toHaveBeenCalledWith(
      { error: runtimeError, hostname: undefined, port: 3009, startupPhase: "after-ready" },
      "[FIX] API server error.",
    );
    expect(process.exitCode).toBeUndefined();
  });
});
