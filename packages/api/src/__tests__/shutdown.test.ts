import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler } from "../shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createGracefulShutdownHandler", () => {
  it("waits for the Codex indexer to stop before closing the server and exiting", async () => {
    const events: string[] = [];
    const stopDeferred = deferred();
    const stopCodexIndex = vi.fn(async () => {
      events.push("stop:start");
      await stopDeferred.promise;
      events.push("stop:end");
    });
    const closeWebSockets = vi.fn(() => {
      events.push("ws:close");
    });
    const closeServer = vi.fn(() => {
      events.push("server:close");
    });
    const exitProcess = vi.fn(() => {
      events.push("exit");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const onShutdown = createGracefulShutdownHandler({
      logger,
      stopCodexIndex,
      closeWebSockets,
      closeServer,
      exitProcess,
    });

    const shutdown = onShutdown("SIGTERM");
    await Promise.resolve();

    expect(exitProcess).not.toHaveBeenCalled();
    expect(closeServer).not.toHaveBeenCalled();

    stopDeferred.resolve();
    await shutdown;

    expect(events).toEqual(["stop:start", "stop:end", "ws:close", "server:close", "exit"]);
    expect(logger.debug).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      "Codex indexer stopped during shutdown",
    );
  });

  it("ignores duplicate shutdown signals while the first shutdown is in progress", async () => {
    const stopDeferred = deferred();
    const stopCodexIndex = vi.fn(async () => {
      await stopDeferred.promise;
    });
    const onShutdown = createGracefulShutdownHandler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      stopCodexIndex,
      closeWebSockets: vi.fn(),
      closeServer: vi.fn(),
      exitProcess: vi.fn(),
    });

    const first = onShutdown("SIGINT");
    await onShutdown("SIGTERM");
    stopDeferred.resolve();
    await first;

    expect(stopCodexIndex).toHaveBeenCalledTimes(1);
  });
});
